import { type Clock, ExternalServiceError, type ProviderQuery } from '@bf/contracts';
import { z } from 'zod';
import type {
  BuildQueriesInput,
  ConnectionCheck,
  DiscoveryProvider,
  ProviderCallContext,
  ProviderFetchResult,
  ProviderKey,
} from '../../../domain/provider.port.ts';
import { distanceM, inTile } from '../../../domain/tile-geometry.ts';
import { csvObjects } from './csv.ts';
import { SCRAPER_RETENTION_DAYS, scraperRecord } from './mapper.ts';

// Self-hosted gosom/google-maps-scraper web API (BF-019): legally sensitive, behind three gates (deployment flag,
// workspace flag, recorded owner acknowledgement). A query creates a job; later pages poll it and download its
// CSV when done (jobs take minutes, so callers get `pollAfterMs`).

const JobCreated = z.object({ id: z.string().min(1).max(100) });
const JobState = z.object({ Status: z.string() }).passthrough();
const JOB_TOKEN = /^job:([A-Za-z0-9-]{1,100})$/;
const MAX_ROWS = 1_000;
const MAX_CSV_BYTES = 20_000_000;

/** The body as text, refusing more than `max` bytes (never buffers an unbounded download). */
async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new ExternalServiceError('maps-scraper', 'result too large', { details: { retryable: false } });
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const phrase = (key: ProviderKey) => key.label ?? key.key.replace(/_/g, ' ');

export const SCRAPER_LICENSING = {
  retentionDays: SCRAPER_RETENTION_DAYS,
  storableFields: ['providerRef'],
  attributionRequired: false,
  attributionText: null,
  commercialUseAllowed: false,
  notes:
    'No licence: scraping Google Maps is likely to breach Google’s Terms of Service. Off by default; needs the ' +
    'deployment flag, the workspace flag and an owner acknowledgement. Reviews are never stored; records ' +
    'expire after 30 days.',
};

export interface MapsScraperOptions {
  readonly clock: Clock;
  readonly baseUrl: string;
  readonly maxTimeSeconds: number;
  /** Workspace gates: the `mapsScraper` flag and the recorded owner acknowledgement (current warning version). */
  readonly acknowledged: (organizationId: string) => Promise<boolean>;
}

export class MapsScraperProvider implements DiscoveryProvider {
  readonly id = 'gmaps_scraper' as const;
  readonly label = 'Google Maps scraper';
  readonly secretName = null;
  readonly taxonomy = 'google_places' as const;
  readonly featureFlag = 'mapsScraper' as const;
  readonly capabilities = {
    textQuery: true,
    categoryFilter: true,
    circle: true,
    bbox: true,
    polygon: false,
    maxResultsPerQuery: MAX_ROWS,
    pagination: true,
  };
  readonly licensing = SCRAPER_LICENSING;
  readonly costModel = {
    currency: 'USD' as const,
    skus: [{ sku: 'scraper_job', label: 'Scraper job call', perThousandUsd: 0, freeMonthlyCalls: 0 }],
    perResultUsd: null,
    notes: 'Self-hosted: infrastructure cost only.',
  };

  constructor(private readonly options: MapsScraperOptions) {}

  isAllowed(organizationId: string): Promise<boolean> {
    return this.options.acknowledged(organizationId);
  }

  buildQueries({ intent, tile, keysByCategory, fieldTier }: BuildQueriesInput): ProviderQuery[] {
    const base = {
      provider: this.id,
      tile,
      languageCode: intent.languageCode,
      fieldTier,
      mode: 'job',
      pageNumber: 0,
    };
    const queries: ProviderQuery[] = intent.categoryIds.flatMap((categoryId) => {
      const keys = keysByCategory.get(categoryId) ?? [];
      return keys.length === 0
        ? []
        : [
            {
              ...base,
              categoryId,
              providerKeys: keys.slice(0, 5).map((k) => k.key),
              keywords: intent.keywords ?? keys.slice(0, 5).map(phrase).join('|'),
            },
          ];
    });
    if (queries.length === 0 && intent.keywords)
      queries.push({ ...base, categoryId: null, providerKeys: [], keywords: intent.keywords });
    return queries;
  }

  skuFor(): string {
    return 'scraper_job';
  }

  /** Create + polls every 30 s until the job's time budget (plus margin) is spent. */
  maxPages(): number {
    return 2 + Math.ceil((this.options.maxTimeSeconds + 300) / 30);
  }

  async fetchPage(query: ProviderQuery, context: ProviderCallContext): Promise<ProviderFetchResult> {
    const job = query.pageToken ? JOB_TOKEN.exec(query.pageToken)?.[1] : undefined;
    if (query.pageToken && !job)
      throw new ExternalServiceError('maps-scraper', 'invalid job token', { details: { retryable: false } });
    return job ? this.poll(job, query, context.signal) : this.create(query, context.signal);
  }

  async testConnection(): Promise<ConnectionCheck> {
    return { ok: true };
  }

  private async create(query: ProviderQuery, signal: AbortSignal): Promise<ProviderFetchResult> {
    const center = query.tile.type === 'Circle' ? query.tile.center : boxCenter(query.tile.bbox);
    const radius =
      query.tile.type === 'Circle'
        ? query.tile.radiusM
        : distanceM(center, { lat: query.tile.bbox.north, lng: query.tile.bbox.east });
    const keywords = (query.keywords ?? '')
      .split('|')
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 5);
    const response = await this.request('/api/v1/jobs', signal, {
      method: 'POST',
      body: JSON.stringify({
        name: `bf-${query.categoryId ?? 'keywords'}`.slice(0, 80),
        keywords,
        lang: query.languageCode.slice(0, 2),
        lat: String(center.lat),
        lon: String(center.lng),
        radius: Math.round(Math.min(50_000, radius)),
        zoom: 15,
        depth: 1,
        email: false,
        max_time: this.options.maxTimeSeconds,
      }),
    });
    const created = JobCreated.safeParse(await response.json().catch(() => undefined));
    if (!created.success) throw new ExternalServiceError('maps-scraper', 'unexpected job answer');
    const { id } = created.data;
    return {
      records: [],
      nextPageToken: `job:${id}`,
      saturated: false,
      sku: 'scraper_job',
      pollAfterMs: 60_000,
    };
  }

  private async poll(job: string, query: ProviderQuery, signal: AbortSignal): Promise<ProviderFetchResult> {
    const answer = await (await this.request(`/api/v1/jobs/${job}`, signal)).json().catch(() => undefined);
    const state = JobState.safeParse(answer);
    if (!state.success) throw new ExternalServiceError('maps-scraper', 'unexpected job state');
    const status = state.data.Status.toLowerCase();
    if (status !== 'ok' && status !== 'failed') {
      return {
        records: [],
        nextPageToken: `job:${job}`,
        saturated: false,
        sku: 'scraper_job',
        pollAfterMs: 30_000,
      };
    }
    try {
      if (status === 'failed') {
        throw new ExternalServiceError('maps-scraper', 'job failed', { details: { retryable: false } });
      }
      const csv = await readCapped(await this.request(`/api/v1/jobs/${job}/download`, signal), MAX_CSV_BYTES);
      const fetchedAt = this.options.clock.now();
      const rows = csvObjects(csv, MAX_ROWS);
      const records = rows
        .flatMap((row) => scraperRecord(row, fetchedAt) ?? [])
        .filter((record) => inTile(record.location, query.tile));
      return { records, nextPageToken: null, saturated: rows.length >= MAX_ROWS, sku: 'scraper_job' };
    } finally {
      // Finished either way: the scraper keeps job files (scraped data) on disk, remove ours.
      await this.request(`/api/v1/jobs/${job}`, signal, { method: 'DELETE' }).catch(() => undefined);
    }
  }

  private async request(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(new URL(path, this.options.baseUrl), {
      ...init,
      headers: { 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) {
      throw new ExternalServiceError('maps-scraper', `answered ${response.status}`, {
        details: { retryable: response.status >= 500 },
      });
    }
    return response;
  }
}

const boxCenter = (box: { west: number; south: number; east: number; north: number }) => ({
  lat: (box.south + box.north) / 2,
  lng: (box.west + box.east) / 2,
});
