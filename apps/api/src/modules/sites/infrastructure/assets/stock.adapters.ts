import { createHash } from 'node:crypto';
import { ExternalServiceError, RateLimitedError } from '@bf/contracts';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { executeWithSignal, policyFor } from '../../../platform/resilience/resilience.ts';
import type { SecretResolver } from '../../../workspace/index.ts';
import type { StockPhoto, StockProvider } from '../../application/stock-and-ai.ts';
import { LICENSING_PROFILES, type StockProviderName } from '../../domain/assets/licensing-profile.ts';
import { normalizeQuery } from '../../domain/assets/stock-queries.ts';

// Stock photo providers (BF-038): Unsplash and Pexels adapters (their payloads validated: provider data is
// untrusted), and a decorator adding the search cache (7 days) and an hourly request budget under each provider's
// limit. Keys come from the workspace vault, then the deployment's.

const PER_PAGE = 20;
const httpsUrl = z.url().refine((value) => value.startsWith('https://'), 'https only');

async function getJson(url: string, headers: Record<string, string>, provider: string): Promise<unknown> {
  return executeWithSignal(policyFor('stock'), undefined, async (signal) => {
    const response = await fetch(url, { headers, signal });
    if (response.status === 429) throw new RateLimitedError(`${provider} rate limit reached`);
    if (!response.ok)
      throw new ExternalServiceError(provider, `answered ${response.status}`, {
        details: { retryable: response.status >= 500 },
      });
    return response.json();
  });
}

const UnsplashPhoto = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  color: z.string().nullable().optional(),
  alt_description: z.string().nullable().optional(),
  urls: z.object({ raw: httpsUrl, small: httpsUrl }),
  user: z.object({ name: z.string().max(200), links: z.object({ html: httpsUrl }) }),
  links: z.object({ html: httpsUrl, download_location: httpsUrl.optional() }),
});

const onHost = (url: string, host: string) => new URL(url).hostname === host;

export class UnsplashProvider implements StockProvider {
  readonly name = 'unsplash' as const;
  constructor(private readonly secrets: Pick<SecretResolver, 'resolve'>) {}

  private async key(organizationId: string) {
    return (await this.secrets.resolve(organizationId, 'unsplash'))?.value;
  }

  async available(organizationId: string) {
    return (await this.key(organizationId)) !== undefined;
  }

  private headers(key: string) {
    return { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' };
  }

  private map(raw: unknown): StockPhoto | undefined {
    const parsed = UnsplashPhoto.safeParse(raw);
    if (!parsed.success) return undefined;
    const photo = parsed.data;
    // Hotlinked: only from Unsplash's image CDN (the validator and the renderer's CSP allow that host only).
    if (!LICENSING_PROFILES.unsplash.hotlinkHosts.some((host) => onHost(photo.urls.raw, host)))
      return undefined;
    return {
      provider: 'unsplash',
      id: photo.id,
      previewUrl: photo.urls.small,
      imageUrl: photo.urls.raw,
      width: photo.width,
      height: photo.height,
      author: photo.user.name,
      authorUrl: photo.user.links.html,
      pageUrl: photo.links.html,
      alt: photo.alt_description ?? null,
      color: photo.color ?? null,
      downloadLocation: photo.links.download_location ?? null,
    };
  }

  async search(organizationId: string, query: string, options: Parameters<StockProvider['search']>[2]) {
    const key = await this.key(organizationId);
    if (!key) return [];
    const url = new URL('https://api.unsplash.com/search/photos');
    url.searchParams.set('query', query);
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', String(options.page ?? 1));
    url.searchParams.set('content_filter', 'high');
    if (options.orientation) url.searchParams.set('orientation', options.orientation);
    const body = z
      .object({ results: z.array(z.unknown()) })
      .safeParse(await getJson(url.toString(), this.headers(key), 'unsplash'));
    if (!body.success) return [];
    return body.data.results.flatMap((raw) => this.map(raw) ?? []);
  }

  async photo(organizationId: string, id: string) {
    const key = await this.key(organizationId);
    if (!key || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return undefined;
    return this.map(await getJson(`https://api.unsplash.com/photos/${id}`, this.headers(key), 'unsplash'));
  }

  async trackDownload(organizationId: string, photo: StockPhoto) {
    const key = await this.key(organizationId);
    // Only Unsplash's own API: the location comes from its payload, never followed elsewhere.
    if (!key || !photo.downloadLocation || !onHost(photo.downloadLocation, 'api.unsplash.com')) return;
    await getJson(photo.downloadLocation, this.headers(key), 'unsplash');
  }
}

const PexelsPhoto = z.object({
  id: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  url: httpsUrl,
  photographer: z.string().max(200),
  photographer_url: httpsUrl,
  avg_color: z.string().nullable().optional(),
  alt: z.string().nullable().optional(),
  src: z.object({ original: httpsUrl, medium: httpsUrl }),
});

export class PexelsProvider implements StockProvider {
  readonly name = 'pexels' as const;
  constructor(private readonly secrets: Pick<SecretResolver, 'resolve'>) {}

  private async key(organizationId: string) {
    return (await this.secrets.resolve(organizationId, 'pexels'))?.value;
  }

  async available(organizationId: string) {
    return (await this.key(organizationId)) !== undefined;
  }

  private map(raw: unknown): StockPhoto | undefined {
    const parsed = PexelsPhoto.safeParse(raw);
    if (!parsed.success || !onHost(parsed.data.src.original, 'images.pexels.com')) return undefined;
    const photo = parsed.data;
    // Our copy: at most 1920 px wide, compressed by Pexels' own image service.
    const copy = new URL(photo.src.original);
    copy.searchParams.set('auto', 'compress');
    copy.searchParams.set('cs', 'tinysrgb');
    copy.searchParams.set('w', '1920');
    const scale = Math.min(1, 1920 / photo.width);
    return {
      provider: 'pexels',
      id: String(photo.id),
      previewUrl: photo.src.medium,
      imageUrl: copy.toString(),
      width: Math.round(photo.width * scale),
      height: Math.round(photo.height * scale),
      author: photo.photographer,
      authorUrl: photo.photographer_url,
      pageUrl: photo.url,
      alt: photo.alt ?? null,
      color: photo.avg_color ?? null,
      downloadLocation: null,
    };
  }

  async search(organizationId: string, query: string, options: Parameters<StockProvider['search']>[2]) {
    const key = await this.key(organizationId);
    if (!key) return [];
    const url = new URL('https://api.pexels.com/v1/search');
    url.searchParams.set('query', query);
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', String(options.page ?? 1));
    if (options.orientation)
      url.searchParams.set(
        'orientation',
        options.orientation === 'squarish' ? 'square' : options.orientation,
      );
    const body = z
      .object({ photos: z.array(z.unknown()) })
      .safeParse(await getJson(url.toString(), { Authorization: key }, 'pexels'));
    if (!body.success) return [];
    return body.data.photos.flatMap((raw) => this.map(raw) ?? []);
  }

  async photo(organizationId: string, id: string) {
    const key = await this.key(organizationId);
    if (!key || !/^\d{1,20}$/.test(id)) return undefined;
    return this.map(
      await getJson(`https://api.pexels.com/v1/photos/${id}`, { Authorization: key }, 'pexels'),
    );
  }

  async trackDownload(): Promise<void> {}
}

const WEEK_SECONDS = 7 * 24 * 3600;

/**
 * Cache and quota around a provider (Decorator): searches and photos are cached a week (the same query from 20
 * generations costs one request); requests per hour stay at 90 % of the provider's limit, the rest refused.
 */
export class GuardedStockProvider implements StockProvider {
  constructor(
    private readonly inner: StockProvider,
    private readonly valkey: Pick<Redis, 'get' | 'set' | 'incr' | 'expire'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get name(): StockProviderName {
    return this.inner.name;
  }

  available(organizationId: string) {
    return this.inner.available(organizationId);
  }

  private async spend(): Promise<void> {
    const limit = LICENSING_PROFILES[this.inner.name].rateLimitPerHour;
    if (limit === null) return;
    const hour = this.now().toISOString().slice(0, 13);
    const key = `bf:stock-quota:${this.inner.name}:${hour}`;
    const used = await this.valkey.incr(key);
    if (used === 1) await this.valkey.expire(key, 3_700);
    if (used > Math.floor(limit * 0.9))
      throw new RateLimitedError(`${this.inner.name}: this hour's request budget is used`);
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = await this.valkey.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
    await this.spend();
    const value = await load();
    await this.valkey.set(key, JSON.stringify(value), 'EX', WEEK_SECONDS);
    return value;
  }

  search(organizationId: string, query: string, options: Parameters<StockProvider['search']>[2]) {
    const id = createHash('sha256')
      .update(`${normalizeQuery(query)}|${options.orientation ?? ''}|${options.page ?? 1}`)
      .digest('hex')
      .slice(0, 32);
    return this.cached(`bf:stock-search:${this.inner.name}:${id}`, () =>
      this.inner.search(organizationId, query, options),
    );
  }

  photo(organizationId: string, id: string) {
    return this.cached(`bf:stock-photo:${this.inner.name}:${id}`, () => this.inner.photo(organizationId, id));
  }

  async trackDownload(organizationId: string, photo: StockPhoto) {
    await this.spend();
    await this.inner.trackDownload(organizationId, photo);
  }
}

/** Deterministic stock photos (tests and E2E; no network): Unsplash-shaped, hotlinked from its CDN host. */
export class FakeStockProvider implements StockProvider {
  readonly name = 'unsplash' as const;
  readonly tracked: string[] = [];

  async available() {
    return true;
  }

  private photoFor(id: string): StockPhoto {
    return {
      provider: 'unsplash',
      id,
      previewUrl: `https://images.unsplash.com/photo-${id}?w=400&ixid=fake`,
      imageUrl: `https://images.unsplash.com/photo-${id}?ixid=fake`,
      width: 2400,
      height: 1600,
      author: 'Ana Example',
      authorUrl: 'https://unsplash.com/@ana_example',
      pageUrl: `https://unsplash.com/photos/${id}`,
      alt: 'calm turquoise sea',
      color: '#2a6f97',
      downloadLocation: `https://api.unsplash.com/photos/${id}/download?ixid=fake`,
    };
  }

  async search(_organizationId: string, query: string) {
    const seed = createHash('sha256').update(normalizeQuery(query)).digest('hex');
    return [0, 1, 2].map((n) => this.photoFor(`fake${seed.slice(n * 6, n * 6 + 6)}`));
  }

  async photo(_organizationId: string, id: string) {
    return /^fake[0-9a-f]{6}$/.test(id) ? this.photoFor(id) : undefined;
  }

  async trackDownload(_organizationId: string, photo: StockPhoto) {
    this.tracked.push(photo.id);
  }
}
