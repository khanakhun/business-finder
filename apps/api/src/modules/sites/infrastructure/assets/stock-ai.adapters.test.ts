import { loadPromptRegistry } from '@bf/ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeImageGenerator, LedgerAiImageAllowance, OpenAiImageGenerator } from './ai-image.adapters.ts';
import { GuardedStockProvider, PexelsProvider, UnsplashProvider } from './stock.adapters.ts';

const secrets = (values: Record<string, string>) => ({
  resolve: async (_org: string | null, name: string) =>
    values[name] ? { value: values[name], source: 'global' as const } : undefined,
});

/** A Valkey stand-in with the commands the adapters use. */
function fakeValkey() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK' as const;
    }),
    incr: vi.fn(async (key: string) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    }),
    incrby: vi.fn(async (key: string, by: number) => {
      const next = Number(store.get(key) ?? '0') + by;
      store.set(key, String(next));
      return next;
    }),
    decrby: vi.fn(async (key: string, by: number) => {
      const next = Number(store.get(key) ?? '0') - by;
      store.set(key, String(next));
      return next;
    }),
    expire: vi.fn(async () => 1),
  };
}

const unsplashPhoto = (overrides: Record<string, unknown> = {}) => ({
  id: 'abc123',
  width: 4000,
  height: 2667,
  color: '#2a6f97',
  alt_description: 'turquoise sea',
  urls: {
    raw: 'https://images.unsplash.com/photo-abc?ixid=x',
    small: 'https://images.unsplash.com/photo-abc?w=400',
  },
  user: { name: 'Ana Ruiz', links: { html: 'https://unsplash.com/@ana' } },
  links: {
    html: 'https://unsplash.com/photos/abc123',
    download_location: 'https://api.unsplash.com/photos/abc123/download?ixid=x',
  },
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('stock providers', () => {
  it('maps Unsplash photos, drops any not on its CDN, and sends its key as Client-ID', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        results: [
          unsplashPhoto(),
          unsplashPhoto({
            id: 'evil',
            urls: { raw: 'https://evil.example/x', small: 'https://evil.example/s' },
          }),
          { junk: true },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new UnsplashProvider(secrets({ unsplash: 'key-1' }));
    const photos = await provider.search('org', 'sea', { orientation: 'landscape' });
    expect(photos.map((photo) => photo.id)).toEqual(['abc123']);
    expect(photos[0]).toMatchObject({
      author: 'Ana Ruiz',
      downloadLocation: expect.stringContaining('api.unsplash.com'),
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain('query=sea');
    expect(url).toContain('orientation=landscape');
    expect(init.headers.Authorization).toBe('Client-ID key-1');
    // Tracking only ever calls Unsplash's own API.
    await provider.trackDownload('org', { ...photos[0]!, downloadLocation: 'https://evil.example/track' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await new UnsplashProvider(secrets({})).available('org')).toBe(false);
  });

  it('maps Pexels photos to a 1920 px compressed copy and sends its key', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        photos: [
          {
            id: 42,
            width: 6000,
            height: 4000,
            url: 'https://www.pexels.com/photo/42/',
            photographer: 'Lee',
            photographer_url: 'https://www.pexels.com/@lee',
            avg_color: '#efe7d8',
            alt: 'linen',
            src: {
              original: 'https://images.pexels.com/photos/42/a.jpeg',
              medium: 'https://images.pexels.com/photos/42/m.jpeg',
            },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const [photo] = await new PexelsProvider(secrets({ pexels: 'pk' })).search('org', 'linen', {
      orientation: 'squarish',
    });
    expect(photo).toMatchObject({ id: '42', width: 1920, height: 1280, provider: 'pexels' });
    expect(photo?.imageUrl).toContain('w=1920');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain('orientation=square');
    expect(init.headers.Authorization).toBe('pk');
  });

  it('caches searches for a week and stops at 90 % of the hourly limit', async () => {
    const valkey = fakeValkey();
    const inner = {
      name: 'unsplash' as const,
      available: async () => true,
      search: vi.fn(async () => []),
      photo: vi.fn(async () => undefined),
      trackDownload: vi.fn(async () => undefined),
    };
    const guarded = new GuardedStockProvider(inner, valkey, () => new Date('2026-10-16T12:00:00Z'));
    await guarded.search('org', 'Sea', {});
    await guarded.search('org', '  sea ', {});
    expect(inner.search).toHaveBeenCalledTimes(1);
    // Unsplash's demo limit is 50 an hour: 45 requests, then refusals.
    for (let i = 0; i < 44; i++) await guarded.search('org', `q${i}`, {});
    await expect(guarded.search('org', 'one more', {})).rejects.toThrow(/request budget/);
  });
});

describe('AI images', () => {
  it('calls OpenAI with the policy prompt and the person’s words as the scene', async () => {
    const png = Buffer.from('fake-png').toString('base64');
    const fetchMock = vi.fn(async () => json({ data: [{ b64_json: png }, { b64_json: png }] }));
    vi.stubGlobal('fetch', fetchMock);
    const generator = new OpenAiImageGenerator(
      'gpt-image-2',
      secrets({ openai: 'sk-test' }),
      loadPromptRegistry(),
    );
    const images = await generator.generate({
      organizationId: 'org',
      prompt: 'turquoise sea',
      aspect: '3:4',
      count: 2,
    });
    expect(images).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    const body = JSON.parse(init.body) as { model: string; prompt: string; size: string; n: number };
    expect(body).toMatchObject({ model: 'gpt-image-2', size: '1024x1536', n: 2 });
    expect(body.prompt).toContain('no people');
    expect(body.prompt).toContain('Scene: turquoise sea');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'moderation' }, 400)),
    );
    await expect(
      generator.generate({ organizationId: 'org', prompt: 'x y z', aspect: '1:1', count: 1 }),
    ).rejects.toThrow(/400/);
    expect(await new OpenAiImageGenerator('m', secrets({}), loadPromptRegistry()).available('org')).toBe(
      false,
    );
  });

  it('draws deterministic fakes, counts a daily cap and writes the ledger', async () => {
    const [a] = await new FakeImageGenerator().generate({
      organizationId: 'o',
      prompt: 'sea',
      aspect: '1:1',
      count: 1,
    });
    const [b] = await new FakeImageGenerator().generate({
      organizationId: 'o',
      prompt: 'sea',
      aspect: '1:1',
      count: 1,
    });
    expect(a?.equals(b ?? Buffer.alloc(0))).toBe(true);
    const ledger = { record: vi.fn(async () => undefined) };
    const allowance = new LedgerAiImageAllowance(
      { check: async () => 'soft' },
      ledger,
      fakeValkey(),
      () => new Date('2026-10-16T12:00:00Z'),
    );
    expect(await allowance.budget('org')).toBe('soft');
    expect(await allowance.reserve('org', 3, 4)).toBe(true);
    expect(await allowance.reserve('org', 2, 4)).toBe(false);
    expect(await allowance.usedToday('org')).toBe(3);
    await allowance.record({
      organizationId: 'org',
      model: 'm',
      images: 2,
      costUsd: 0.12,
      latencyMs: 900,
      status: 'ok',
    });
    expect(ledger.record).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'assets.ai_image', costUsd: 0.12, provider: 'openai' }),
    );
  });
});
