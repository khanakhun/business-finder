import type { ApiEnv } from '@bf/config';
import {
  DEFAULT_ENRICHMENT_SETTINGS,
  type EmailVerifierId,
  ExternalServiceError,
  fixedClock,
  ValidationError,
} from '@bf/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../platform/config/app-env.ts';
import type { RateLimiter } from '../../platform/rate-limit/valkey-rate-limiter.ts';
import type { WorkspaceDefaults } from '../../workspace/index.ts';
import { type EmailCheck, fromDns, fromReacher, fromZeroBounce } from '../domain/email-verification.ts';
import { EmailVerificationService } from './email-verification.service.ts';
import type { CachedVerdict, EmailVerdictCache, EmailVerifier } from './ports.ts';

const ORG = '00000000-0000-7000-8000-0000000000aa';
const NOW = '2026-10-15T12:00:00.000Z';
const DAY = 24 * 3_600_000;

const verifier = (
  id: EmailVerifierId,
  answer: EmailCheck | Error,
  available = true,
): EmailVerifier & { calls: string[] } => {
  const calls: string[] = [];
  return {
    id,
    calls,
    available: async () => available,
    verify: async (email) => {
      calls.push(email);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
};
const SAFE = fromReacher({ is_reachable: 'safe', smtp: { is_catch_all: false } });
const REACHER_UNKNOWN = fromReacher({ is_reachable: 'unknown' });
const ZB_VALID = fromZeroBounce({ status: 'valid' }, 0.008);
const DNS_UNKNOWN = fromDns({ mx: ['mx.example.test'], nullMx: false, hasAddress: false });
const transient = new ExternalServiceError('reacher', 'timed out', {
  details: { reason: 'timeout', retryable: true },
});

function harness(
  verifiers: EmailVerifier[],
  options: {
    chain?: EmailVerifierId[];
    wait?: number;
    suppressed?: boolean;
    cached?: CachedVerdict;
  } = {},
) {
  const clock = fixedClock(NOW);
  const store = new Map<string, CachedVerdict>(
    options.cached ? [['info@salon.example.com', options.cached]] : [],
  );
  const cache: EmailVerdictCache = {
    get: async (email) => store.get(email),
    put: async (email, verdict) => {
      store.set(email, verdict);
    },
  };
  const limiter = {
    tryTake: vi.fn(async () => options.wait ?? 0),
    acquire: vi.fn(),
  } as unknown as RateLimiter;
  const defaults = {
    enrichmentSettings: async () => ({
      ...DEFAULT_ENRICHMENT_SETTINGS,
      emailVerifiers: options.chain ?? ['reacher', 'zerobounce', 'dns'],
    }),
  } as unknown as WorkspaceDefaults;
  const env = {
    EMAIL_VERIFY_PER_DOMAIN_PER_MINUTE: 6,
    ENRICHMENT_TTL_EMAIL_VERIFY_DAYS: 60,
  } as Partial<ApiEnv> as AppEnv;
  const service = new EmailVerificationService(
    verifiers,
    cache,
    { isSuppressed: async () => options.suppressed ?? false },
    limiter,
    defaults,
    clock,
    env,
  );
  const verify = (email = 'info@salon.example.com') =>
    service.verify(ORG, email, new AbortController().signal);
  return { service, verify, store, limiter, clock };
}

describe('EmailVerificationService', () => {
  it('stops at the first conclusive verdict and caches it for the TTL', async () => {
    const reacher = verifier('reacher', SAFE);
    const zerobounce = verifier('zerobounce', ZB_VALID);
    const { verify, store } = harness([reacher, zerobounce, verifier('dns', DNS_UNKNOWN)]);
    const outcome = await verify('Info@Salon.example.com ');
    expect(outcome).toMatchObject({ kind: 'verdict', cached: false, costUsd: 0, check: { status: 'valid' } });
    expect(reacher.calls).toEqual(['info@salon.example.com']);
    expect(zerobounce.calls).toEqual([]);
    expect(store.get('info@salon.example.com')).toMatchObject({
      inconclusiveStreak: 0,
      expiresAt: new Date(Date.parse(NOW) + 60 * DAY),
    });
  });

  it('falls back down the chain: an inconclusive or failed verifier hands over to the next', async () => {
    const reacher = verifier('reacher', REACHER_UNKNOWN);
    const zerobounce = verifier('zerobounce', ZB_VALID);
    const { verify } = harness([reacher, zerobounce, verifier('dns', DNS_UNKNOWN)]);
    expect(await verify()).toMatchObject({ check: { status: 'valid' }, costUsd: 0.008 });

    const down = verifier('reacher', transient);
    const { verify: verify2 } = harness([down, verifier('zerobounce', ZB_VALID)]);
    expect(await verify2()).toMatchObject({
      check: { status: 'valid', details: { checkedVia: 'zerobounce' } },
    });
  });

  it('skips verifiers this workspace cannot use and follows its order', async () => {
    const reacher = verifier('reacher', SAFE, false);
    const zerobounce = verifier('zerobounce', ZB_VALID);
    const dns = verifier('dns', DNS_UNKNOWN);
    const { verify } = harness([reacher, zerobounce, dns], { chain: ['dns', 'reacher', 'zerobounce'] });
    // DNS is first and inconclusive; Reacher is unavailable; ZeroBounce answers.
    expect(await verify()).toMatchObject({ check: { status: 'valid' } });
    expect(reacher.calls).toEqual([]);
    expect(dns.calls).toHaveLength(1);
  });

  it('keeps the first inconclusive answer when nothing better comes, and backs off its re-check', async () => {
    const { verify, store, clock } = harness([
      verifier('reacher', REACHER_UNKNOWN),
      verifier('dns', DNS_UNKNOWN),
    ]);
    const first = await verify();
    expect(first).toMatchObject({ check: { status: 'unknown', details: { checkedVia: 'reacher' } } });
    expect(store.get('info@salon.example.com')).toMatchObject({ inconclusiveStreak: 1 });
    expect(first.kind === 'verdict' && first.expiresAt).toEqual(new Date(Date.parse(NOW) + DAY));
    clock.advance(DAY);
    await verify();
    expect(store.get('info@salon.example.com')).toMatchObject({
      inconclusiveStreak: 2,
      expiresAt: new Date(Date.parse(NOW) + DAY + 2 * DAY),
    });
  });

  it('answers from the cache while it is fresh (no verifier, no token, no cost)', async () => {
    const reacher = verifier('reacher', SAFE);
    const cached: CachedVerdict = {
      check: { ...ZB_VALID, costUsd: 0.008 },
      checkedAt: new Date('2026-10-01T00:00:00.000Z'),
      expiresAt: new Date('2026-11-30T00:00:00.000Z'),
      inconclusiveStreak: 0,
    };
    const { verify, limiter } = harness([reacher], { cached });
    expect(await verify()).toMatchObject({
      kind: 'verdict',
      cached: true,
      costUsd: 0,
      checkedAt: cached.checkedAt,
    });
    expect(reacher.calls).toEqual([]);
    expect(limiter.tryTake).not.toHaveBeenCalled();
  });

  it('checks an expired cache entry again', async () => {
    const reacher = verifier('reacher', SAFE);
    const cached: CachedVerdict = {
      check: REACHER_UNKNOWN,
      checkedAt: new Date('2026-10-10T00:00:00.000Z'),
      expiresAt: new Date('2026-10-11T00:00:00.000Z'),
      inconclusiveStreak: 1,
    };
    const { verify, store } = harness([reacher], { cached });
    expect(await verify()).toMatchObject({ cached: false, check: { status: 'valid' } });
    expect(store.get('info@salon.example.com')?.inconclusiveStreak).toBe(0);
  });

  it('never checks a suppressed address (before cache and verifiers)', async () => {
    const reacher = verifier('reacher', SAFE);
    const { verify, store } = harness([reacher], { suppressed: true });
    expect(await verify()).toEqual({ kind: 'suppressed' });
    expect(reacher.calls).toEqual([]);
    expect(store.size).toBe(0);
  });

  it('a disposable domain is classified without a check or a token', async () => {
    const reacher = verifier('reacher', SAFE);
    const { verify, limiter, store } = harness([reacher]);
    expect(await verify('promo@mailinator.com')).toMatchObject({
      check: { status: 'disposable', details: { checkedVia: 'classification' } },
    });
    expect(reacher.calls).toEqual([]);
    expect(limiter.tryTake).not.toHaveBeenCalled();
    expect(store.has('promo@mailinator.com')).toBe(true);
  });

  it('takes a token from the recipient domain’s bucket and reports the wait when it is empty', async () => {
    const reacher = verifier('reacher', SAFE);
    const { verify, limiter } = harness([reacher], { wait: 7_000 });
    expect(await verify()).toEqual({ kind: 'rate_limited', retryAfterMs: 7_000 });
    expect(reacher.calls).toEqual([]);
    expect(limiter.tryTake).toHaveBeenCalledWith('email-verify:salon.example.com', {
      capacity: 6,
      perSecond: 0.1,
    });
  });

  it('when every verifier fails, rethrows the last error (the engine retries transient ones) and caches nothing', async () => {
    const { verify, store } = harness([verifier('reacher', transient), verifier('dns', transient)]);
    await expect(verify()).rejects.toBe(transient);
    expect(store.size).toBe(0);
    const permanent = new ValidationError('bad');
    const { verify: verify2 } = harness([verifier('reacher', permanent)], { chain: ['reacher'] });
    await expect(verify2()).rejects.toBe(permanent);
  });

  it('reports a chain with nothing usable', async () => {
    const { verify } = harness([verifier('zerobounce', ZB_VALID, false)], { chain: ['zerobounce'] });
    expect(await verify()).toEqual({ kind: 'unavailable' });
  });
});
