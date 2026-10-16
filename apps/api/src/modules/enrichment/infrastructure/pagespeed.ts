import {
  type Clock,
  ExternalServiceError,
  type PsiStrategy,
  type PsiStrategyResult,
  RateLimitedError,
} from '@bf/contracts';
import { z } from 'zod';
import { executeWithSignal, policyFor } from '../../platform/resilience/resilience.ts';
import type { PageSpeedPort } from '../application/ports.ts';

// PageSpeed Insights API v5 (BF-030): `GET /pagespeedonline/v5/runPagespeed?url&strategy&category…&key` — verified
// 2026-10-16 (strategy MOBILE|DESKTOP; categories PERFORMANCE, ACCESSIBILITY, BEST_PRACTICES, SEO; a key is
// recommended for automated use; default quota 25,000 queries/day and 400 per 100 s per project). Only a compact
// result is kept: four category scores, six lab metrics (+ field INP), the top opportunities.

export const PSI_ENDPOINT = 'https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed';
const CATEGORIES = ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO'] as const;
/** A Lighthouse run takes 10–40 s: generous, the policy's timeout sits just above. */
const REQUEST_TIMEOUT_MS = 90_000;

const Audit = z
  .object({
    numericValue: z.number().optional().catch(undefined),
    title: z.string().optional().catch(undefined),
    details: z
      .object({
        type: z.string().optional().catch(undefined),
        overallSavingsMs: z.number().optional().catch(undefined),
        overallSavingsBytes: z.number().optional().catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();
const Category = z
  .object({ score: z.number().min(0).max(1).nullable().optional().catch(null) })
  .passthrough();
const PsiResponse = z.object({
  analysisUTCTimestamp: z.string().optional().catch(undefined),
  loadingExperience: z
    .object({
      metrics: z
        .record(z.string(), z.object({ percentile: z.number().optional().catch(undefined) }).passthrough())
        .optional()
        .catch(undefined),
    })
    .passthrough()
    .optional()
    .catch(undefined),
  lighthouseResult: z.object({
    lighthouseVersion: z.string().max(30).optional().catch(undefined),
    categories: z.record(z.string(), Category).default({}).catch({}),
    audits: z.record(z.string(), Audit).default({}).catch({}),
  }),
});

const toScore = (category: z.infer<typeof Category> | undefined) =>
  typeof category?.score === 'number' ? Math.round(category.score * 100) : null;
const numeric = (audits: Record<string, z.infer<typeof Audit>>, id: string) => {
  const value = audits[id]?.numericValue;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
};

/** The compact result of one PSI answer (pure; unit-tested on recorded-shape fixtures). */
export function toPsiStrategyResult(json: unknown, fetchedAt: Date): PsiStrategyResult {
  const parsed = PsiResponse.safeParse(json);
  if (!parsed.success) {
    throw new ExternalServiceError('pagespeed', 'unexpected response', {
      details: { reason: 'UNEXPECTED_RESPONSE', retryable: false },
    });
  }
  const { lighthouseResult, loadingExperience, analysisUTCTimestamp } = parsed.data;
  const { audits, categories } = lighthouseResult;
  const opportunities = Object.entries(audits)
    .filter(([, audit]) => audit.details?.type === 'opportunity' && (audit.details.overallSavingsMs ?? 0) > 0)
    .map(([id, audit]) => ({
      id: id.slice(0, 100),
      title: (audit.title ?? id).slice(0, 200),
      savingsMs: audit.details?.overallSavingsMs ?? null,
      savingsBytes: audit.details?.overallSavingsBytes ?? null,
    }))
    .sort((a, b) => (b.savingsMs ?? 0) - (a.savingsMs ?? 0))
    .slice(0, 5);
  const inp = loadingExperience?.metrics?.INTERACTION_TO_NEXT_PAINT?.percentile;
  const timestamp = analysisUTCTimestamp ? Date.parse(analysisUTCTimestamp) : Number.NaN;
  return {
    scores: {
      performance: toScore(categories.performance),
      accessibility: toScore(categories.accessibility),
      bestPractices: toScore(categories['best-practices']),
      seo: toScore(categories.seo),
    },
    metrics: {
      lcpMs: numeric(audits, 'largest-contentful-paint'),
      cls: numeric(audits, 'cumulative-layout-shift'),
      tbtMs: numeric(audits, 'total-blocking-time'),
      fcpMs: numeric(audits, 'first-contentful-paint'),
      speedIndexMs: numeric(audits, 'speed-index'),
      ttfbMs: numeric(audits, 'server-response-time'),
      inpMs: typeof inp === 'number' && inp >= 0 ? inp : null,
    },
    opportunities,
    lighthouseVersion: lighthouseResult.lighthouseVersion ?? null,
    fetchedAt: new Date(Number.isFinite(timestamp) ? timestamp : fetchedAt.getTime()).toISOString(),
  };
}

const ErrorBody = z
  .object({ error: z.object({ message: z.string().optional() }).passthrough() })
  .passthrough();

/** Bounded, sanitized errors: never the URL (it carries the key) nor the provider's free text. */
async function toError(response: Response): Promise<Error> {
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    return new RateLimitedError(
      'PageSpeed quota reached.',
      Number.isFinite(seconds) && seconds >= 0 ? Math.min(3_600, Math.ceil(seconds)) : undefined,
    );
  }
  const body = ErrorBody.safeParse(await response.json().catch(() => undefined));
  const message = body.success ? (body.data.error.message ?? '') : '';
  // 400 is either a bad key (configuration) or a page Lighthouse could not load (this site, not us).
  const reason =
    response.status === 400 && /api key/i.test(message)
      ? 'KEY_INVALID'
      : response.status === 400
        ? 'PAGE_FAILED'
        : response.status === 403
          ? 'FORBIDDEN'
          : `HTTP_${response.status}`;
  return new ExternalServiceError('pagespeed', `answered ${response.status}`, {
    details: { reason, retryable: response.status >= 500 },
  });
}

export class PageSpeedClient implements PageSpeedPort {
  constructor(
    private readonly clock: Clock,
    private readonly endpoint = PSI_ENDPOINT,
  ) {}

  run(
    url: string,
    strategy: PsiStrategy,
    options: { readonly key: string | undefined; readonly signal: AbortSignal },
  ): Promise<PsiStrategyResult> {
    const request = new URL(this.endpoint);
    request.searchParams.set('url', url);
    request.searchParams.set('strategy', strategy.toUpperCase());
    for (const category of CATEGORIES) request.searchParams.append('category', category);
    request.searchParams.set('locale', 'en');
    // The documented way; span URLs are redacted (`key` query parameters, BF-028).
    if (options.key) request.searchParams.set('key', options.key);
    return executeWithSignal(policyFor('pagespeed'), options.signal, async (signal) => {
      const response = await fetch(request, {
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (!response.ok) throw await toError(response);
      return toPsiStrategyResult(await response.json().catch(() => undefined), this.clock.now());
    });
  }
}

/**
 * PageSpeed for tests and E2E (`FAKE_WEBSITE_AUDIT`; refused in production): a host containing `slow` gets poor
 * results, any other a good one. Nothing is called.
 */
export class FakePageSpeed implements PageSpeedPort {
  constructor(private readonly clock: Clock) {}

  async run(url: string, strategy: PsiStrategy): Promise<PsiStrategyResult> {
    const slow = new URL(url).hostname.includes('slow');
    const mobile = strategy === 'mobile';
    return {
      scores: slow
        ? { performance: mobile ? 28 : 45, accessibility: 62, bestPractices: 70, seo: 66 }
        : { performance: mobile ? 86 : 95, accessibility: 92, bestPractices: 100, seo: 92 },
      metrics: slow
        ? {
            lcpMs: mobile ? 6_400 : 3_100,
            cls: 0.31,
            tbtMs: 900,
            fcpMs: 3_200,
            speedIndexMs: 7_000,
            ttfbMs: 1_900,
            inpMs: null,
          }
        : {
            lcpMs: mobile ? 2_100 : 1_200,
            cls: 0.03,
            tbtMs: 80,
            fcpMs: 1_100,
            speedIndexMs: 2_000,
            ttfbMs: 350,
            inpMs: null,
          },
      opportunities: slow
        ? [
            {
              id: 'uses-optimized-images',
              title: 'Efficiently encode images',
              savingsMs: 2_400,
              savingsBytes: 1_800_000,
            },
          ]
        : [],
      lighthouseVersion: '12.0.0',
      fetchedAt: this.clock.now().toISOString(),
    };
  }
}
