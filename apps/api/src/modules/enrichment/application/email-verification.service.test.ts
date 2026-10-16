import type { ApiEnv } from '@bf/config';
import {
  DEFAULT_ENRICHMENT_SETTINGS,
  type EmailVerifierId,
  ExternalServiceError,
  fixedClock,
  ValidationError,
} from '@bf/contracts';
import { createLogger } from '@bf/observability';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../platform/config/app-env.ts';
import type { WorkspaceDefaults } from '../../workspace/index.ts';
import {
  type EmailCheck,
  fromDns,
  fromReacher,
  fromZeroBounce,
  MailServerBusyError,
} from '../domain/email-verification.ts';
import { EmailVerificationService } from './email-verification.service.ts';
import type { CachedVerdict, EmailVerdictCache, EmailVerifier } from './ports.ts';

const ORG = '00000000-0000-7000-8000-0000000000aa';
const NOW = '2026-10-15T12:00:00.000Z';
const DAY = 24 * 3_600_000;
const ADDRESS = 'info@salon.example.com';

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
const permanent = new ExternalServiceError('zerobounce', 'rejected the request', {
  details: { reason: 'PROVIDER_ERROR', retryable: false },
});

function harness(
  verifiers: EmailVerifier[],
  options: { chain?: EmailVerifierId[]; suppressed?: boolean; cached?: CachedVerdict } = {},
) {
  const clock = fixedClock(NOW);
  const store = new Map<string, CachedVerdict>(options.cached ? [[ADDRESS, options.cached]] : []);
  const cache: EmailVerdictCache = {
    get: async (email) => store.get(email),
    put: async (email, verdict) => {
      store.set(email, verdict);
    },
    purgeExpired: async () => 0,
  };
  const defaults = {
    enrichmentSettings: async () => ({
      ...DEFAULT_ENRICHMENT_SETTINGS,
      emailVerifiers: options.chain ?? ['reacher', 'zerobounce', 'dns'],
    }),
  } as unknown as WorkspaceDefaults;
  const env = { ENRICHMENT_TTL_EMAIL_VERIFY_DAYS: 60 } as Partial<ApiEnv> as AppEnv;
  const service = new EmailVerificationService(
    verifiers,
    cache,
    { isSuppressed: async () => options.suppressed ?? false },
    defaults,
    clock,
    env,
    createLogger({ service: 'test', level: 'fatal' }),
  );
  const verify = (email = ADDRESS, cacheIt = true) =>
    service.verify(ORG, email, new AbortController().signal, { cache: cacheIt });
  return { service, verify, store, clock };
}

describe('EmailVerificationService', () => {
  it('stops at the first conclusive verdict and caches it for the TTL', async () => {
    const reacher = verifier('reacher', SAFE);
    const zerobounce = verifier('zerobounce', ZB_VALID);
    const { verify, store } = harness([reacher, zerobounce, verifier('dns', DNS_UNKNOWN)]);
    const outcome = await verify('Info@Salon.example.com ');
    expect(outcome).toMatchObject({ kind: 'verdict', cached: false, costUsd: 0, check: { status: 'valid' } });
    expect(reacher.calls).toEqual([ADDRESS]);
    expect(zerobounce.calls).toEqual([]);
    expect(store.get(ADDRESS)).toMatchObject({
      inconclusiveStreak: 0,
      expiresAt: new Date(Date.parse(NOW) + 60 * DAY),
    });
  });

  it('falls back down the chain: an inconclusive answer or a permanent failure hands over to the next', async () => {
    const { verify } = harness([verifier('reacher', REACHER_UNKNOWN), verifier('zerobounce', ZB_VALID)]);
    expect(await verify()).toMatchObject({ check: { status: 'valid' }, costUsd: 0.008 });
    const misconfigured = harness([verifier('zerobounce', permanent), verifier('dns', DNS_UNKNOWN)], {
      chain: ['zerobounce', 'dns'],
    });
    expect(await misconfigured.verify()).toMatchObject({
      check: { status: 'unknown', details: { checkedVia: 'dns' } },
    });
  });

  it('a verifier that is down gives only a provisional, uncached answer (circuit open, DNS says unknown)', async () => {
    const circuitOpen = new ExternalServiceError('reacher', 'unavailable', {
      details: { reason: 'circuit_open', retryable: true },
    });
    const { verify, store } = harness([verifier('reacher', circuitOpen), verifier('dns', DNS_UNKNOWN)]);
    expect(await verify()).toMatchObject({
      kind: 'verdict',
      provisional: true,
      cached: false,
      check: { status: 'unknown', details: { checkedVia: 'dns' } },
    });
    // Nobody inherits an outage's "unknown".
    expect(store.size).toBe(0);
    // A conclusive answer after the failure is a normal verdict.
    const recovered = harness([verifier('reacher', transient), verifier('zerobounce', ZB_VALID)]);
    const outcome = await recovered.verify();
    expect(outcome).toMatchObject({ check: { status: 'valid' } });
    expect(outcome.kind === 'verdict' && outcome.provisional).toBeFalsy();
  });

  it('lets paid verifiers check the budget with what the step already spent', async () => {
    const seen: unknown[] = [];
    const zerobounce: EmailVerifier = {
      ...verifier('zerobounce', ZB_VALID),
      available: async (_org, context) => {
        seen.push(context);
        return true;
      },
    };
    const { service } = harness([zerobounce], { chain: ['zerobounce'] });
    await service.verify(ORG, ADDRESS, new AbortController().signal, { pendingUsd: 0.024 });
    expect(seen).toEqual([{ pendingUsd: 0.024 }]);
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
    expect(store.get(ADDRESS)).toMatchObject({ inconclusiveStreak: 1 });
    expect(first.kind === 'verdict' && first.expiresAt).toEqual(new Date(Date.parse(NOW) + DAY));
    clock.advance(DAY);
    await verify();
    expect(store.get(ADDRESS)).toMatchObject({
      inconclusiveStreak: 2,
      expiresAt: new Date(Date.parse(NOW) + DAY + 2 * DAY),
    });
  });

  it('answers from the cache while it is fresh (no verifier, no cost)', async () => {
    const reacher = verifier('reacher', SAFE);
    const cached: CachedVerdict = {
      check: { ...ZB_VALID, costUsd: 0.008 },
      checkedAt: new Date('2026-10-01T00:00:00.000Z'),
      expiresAt: new Date('2026-11-30T00:00:00.000Z'),
      inconclusiveStreak: 0,
    };
    const { verify } = harness([reacher], { cached });
    expect(await verify()).toMatchObject({
      kind: 'verdict',
      cached: true,
      costUsd: 0,
      checkedAt: cached.checkedAt,
    });
    expect(reacher.calls).toEqual([]);
  });

  it('a DNS-only "unknown" from another workspace never hides a mailbox check', async () => {
    const cached: CachedVerdict = {
      check: DNS_UNKNOWN,
      checkedAt: new Date('2026-10-15T00:00:00.000Z'),
      expiresAt: new Date('2026-10-16T00:00:00.000Z'),
      inconclusiveStreak: 1,
    };
    const reacher = verifier('reacher', SAFE);
    expect(await harness([reacher], { cached }).verify()).toMatchObject({
      cached: false,
      check: { status: 'valid' },
    });
    // A DNS-only workspace reuses it.
    const dnsOnly = harness([verifier('dns', DNS_UNKNOWN)], { cached, chain: ['dns'] });
    expect(await dnsOnly.verify()).toMatchObject({ cached: true });
  });

  it('checks an expired cache entry again', async () => {
    const cached: CachedVerdict = {
      check: REACHER_UNKNOWN,
      checkedAt: new Date('2026-10-10T00:00:00.000Z'),
      expiresAt: new Date('2026-10-11T00:00:00.000Z'),
      inconclusiveStreak: 1,
    };
    const { verify, store } = harness([verifier('reacher', SAFE)], { cached });
    expect(await verify()).toMatchObject({ cached: false, check: { status: 'valid' } });
    expect(store.get(ADDRESS)?.inconclusiveStreak).toBe(0);
  });

  it('never checks a suppressed address (before cache and verifiers)', async () => {
    const reacher = verifier('reacher', SAFE);
    const { verify, store } = harness([reacher], { suppressed: true });
    expect(await verify()).toEqual({ kind: 'suppressed' });
    expect(reacher.calls).toEqual([]);
    expect(store.size).toBe(0);
  });

  it('a disposable domain is classified without a check', async () => {
    const reacher = verifier('reacher', SAFE);
    const { verify, store } = harness([reacher]);
    expect(await verify('info@mailinator.com')).toMatchObject({
      check: { status: 'disposable', details: { checkedVia: 'classification', isRoleAccount: true } },
    });
    expect(reacher.calls).toEqual([]);
    expect(store.has('info@mailinator.com')).toBe(true);
  });

  it('reports a busy mail server without asking anyone else', async () => {
    const zerobounce = verifier('zerobounce', ZB_VALID);
    const { verify, store } = harness([verifier('reacher', new MailServerBusyError(7_000)), zerobounce]);
    expect(await verify()).toEqual({ kind: 'rate_limited', retryAfterMs: 7_000 });
    expect(zerobounce.calls).toEqual([]);
    expect(store.size).toBe(0);
  });

  it('does not cache what it is told not to (name-pattern guesses)', async () => {
    const { verify, store } = harness([verifier('reacher', SAFE)]);
    expect(await verify('marie.curie@salon.example.com', false)).toMatchObject({
      check: { status: 'valid' },
    });
    expect(store.size).toBe(0);
  });

  it('when every verifier fails, rethrows the last error and caches nothing', async () => {
    const { verify, store } = harness([verifier('reacher', transient), verifier('dns', transient)]);
    await expect(verify()).rejects.toBe(transient);
    expect(store.size).toBe(0);
    const bad = new ValidationError('bad');
    const { verify: verify2 } = harness([verifier('reacher', bad)], { chain: ['reacher'] });
    await expect(verify2()).rejects.toBe(bad);
  });

  it('reports a chain with nothing usable', async () => {
    const { verify } = harness([verifier('zerobounce', ZB_VALID, false)], { chain: ['zerobounce'] });
    expect(await verify()).toEqual({ kind: 'unavailable' });
  });
});
