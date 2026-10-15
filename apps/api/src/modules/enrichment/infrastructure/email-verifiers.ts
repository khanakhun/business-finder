import { Resolver } from 'node:dns/promises';
import { ExternalServiceError } from '@bf/contracts';
import { BrokenCircuitError, TaskCancelledError } from 'cockatiel';
import { policyFor, type ResiliencePolicyName } from '../../platform/resilience/resilience.ts';
import type { ResolvedSecret } from '../../workspace/index.ts';
import type { EmailVerifier } from '../application/ports.ts';
import { type EmailCheck, fromDns, fromReacher, fromZeroBounce } from '../domain/email-verification.ts';

// Verifier adapters of the e-mail chain (BF-028). Their failures are typed `ExternalServiceError`s carrying only a
// sanitized reason — never a provider's free text, never a URL (ZeroBounce takes its key in the query string).

/** Resilience outcomes as the typed, transient errors the engine and the chain understand. */
async function resilient<T>(
  service: string,
  policy: ResiliencePolicyName,
  signal: AbortSignal,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  try {
    return await policyFor(policy).execute(({ signal: attempt }) => call(attempt), signal);
  } catch (error) {
    if (error instanceof BrokenCircuitError) {
      throw new ExternalServiceError(service, 'unavailable', {
        details: { reason: 'circuit_open', retryable: true },
      });
    }
    if (error instanceof TaskCancelledError && !signal.aborted) {
      throw new ExternalServiceError(service, 'timed out', {
        details: { reason: 'timeout', retryable: true },
      });
    }
    if (error instanceof ExternalServiceError || signal.aborted) throw error;
    // Network errors (fetch failed, DNS) are transient; their messages may quote the request: not kept.
    throw new ExternalServiceError(service, 'request failed', {
      details: { reason: 'network', retryable: true },
    });
  }
}

function httpError(service: string, status: number): ExternalServiceError {
  // 4xx: our request or our key is wrong — retrying cannot help (and must not trip the breaker).
  return new ExternalServiceError(service, `answered ${status}`, {
    details: { reason: `HTTP_${status}`, retryable: status >= 500 || status === 429 },
  });
}

/** At most `limit` calls at once in this process (SMTP checks are slow and mail servers notice parallel ones). */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

/**
 * Self-hosted Reacher (`check-if-email-exists` backend, compose profile `verify`): `POST /v1/check_email`. It talks
 * SMTP to the recipient's mail server, so it needs outbound port 25 (see the SMTP port diagnostic).
 */
export class ReacherVerifier implements EmailVerifier {
  readonly id = 'reacher' as const;
  private readonly slots: Semaphore;

  constructor(
    private readonly baseUrl: string | undefined,
    concurrency: number,
  ) {
    this.slots = new Semaphore(concurrency);
  }

  async available(): Promise<boolean> {
    return Boolean(this.baseUrl);
  }

  verify(email: string, context: { readonly signal: AbortSignal }): Promise<EmailCheck> {
    const baseUrl = this.baseUrl;
    if (!baseUrl) return Promise.reject(new Error('Reacher is not configured'));
    return this.slots.run(() =>
      resilient('reacher', 'reacher', context.signal, async (signal) => {
        const response = await fetch(new URL('/v1/check_email', baseUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to_email: email }),
          signal,
        });
        const body: unknown = await response.json().catch(() => undefined);
        if (!response.ok) throw httpError('reacher', response.status);
        if (typeof body !== 'object' || body === null) {
          throw new ExternalServiceError('reacher', 'unexpected response', {
            details: { reason: 'UNEXPECTED_RESPONSE', retryable: false },
          });
        }
        return fromReacher(body);
      }),
    );
  }
}

export const ZEROBOUNCE_BASE_URL = 'https://api.zerobounce.net';
/** Seconds ZeroBounce may spend on one address before answering `unknown` (not billed). */
const ZEROBOUNCE_TIMEOUT_SECONDS = 20;

/** ZeroBounce (`GET /v2/validate`): the commercial verifier for hosts where port 25 is blocked. */
export class ZeroBounceVerifier implements EmailVerifier {
  readonly id = 'zerobounce' as const;

  constructor(
    private readonly key: (organizationId: string) => Promise<ResolvedSecret | undefined>,
    private readonly unitCostUsd: number,
    private readonly baseUrl: string = ZEROBOUNCE_BASE_URL,
  ) {}

  async available(organizationId: string): Promise<boolean> {
    return (await this.key(organizationId)) !== undefined;
  }

  async verify(
    email: string,
    context: { readonly organizationId: string; readonly signal: AbortSignal },
  ): Promise<EmailCheck> {
    const secret = await this.key(context.organizationId);
    if (!secret) throw new Error('No ZeroBounce key');
    return resilient('zerobounce', 'zerobounce', context.signal, async (signal) => {
      const url = new URL('/v2/validate', this.baseUrl);
      url.searchParams.set('api_key', secret.value);
      url.searchParams.set('email', email);
      url.searchParams.set('ip_address', '');
      url.searchParams.set('timeout', String(ZEROBOUNCE_TIMEOUT_SECONDS));
      const response = await fetch(url, { signal });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw httpError('zerobounce', response.status);
      if (typeof body !== 'object' || body === null) {
        throw new ExternalServiceError('zerobounce', 'unexpected response', {
          details: { reason: 'UNEXPECTED_RESPONSE', retryable: false },
        });
      }
      if ('error' in body) {
        // An invalid key or no credits left (answered with 200): configuration, not a transient failure.
        throw new ExternalServiceError('zerobounce', 'rejected the request', {
          details: { reason: 'PROVIDER_ERROR', retryable: false },
        });
      }
      return fromZeroBounce(body, this.unitCostUsd);
    });
  }

  /** Connection test (Settings → Integrations): the key's remaining credits (`-1` for an unknown key). */
  static async testKey(
    key: string,
    signal: AbortSignal,
    baseUrl: string = ZEROBOUNCE_BASE_URL,
  ): Promise<{ ok: boolean; message: string }> {
    const url = new URL('/v2/getcredits', baseUrl);
    url.searchParams.set('api_key', key);
    const response = await fetch(url, { signal });
    const body = (await response.json().catch(() => undefined)) as { Credits?: unknown } | undefined;
    const credits = Number(body?.Credits);
    if (!response.ok || !Number.isFinite(credits) || credits < 0) {
      return { ok: false, message: 'ZeroBounce rejected the key.' };
    }
    return { ok: true, message: `${Math.floor(credits)} credits left.` };
  }
}

/** The lookups the DNS verifier makes (`node:dns` `Resolver` in production). */
export interface MailDns {
  resolveMx(domain: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

const DNS_TIMEOUT_MS = 3_000;
/** DNS answers meaning "no such record" (as opposed to a failed lookup). */
const NO_DATA = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);

/** DNS only (syntax was checked when the contact was stored): MX, null MX, implicit MX — never a mailbox check. */
export class DnsMxVerifier implements EmailVerifier {
  readonly id = 'dns' as const;

  constructor(private readonly resolver: MailDns = dnsResolver()) {}

  async available(): Promise<boolean> {
    return true;
  }

  async verify(email: string): Promise<EmailCheck> {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    const mx = await this.lookup(() => this.resolver.resolveMx(domain));
    const nullMx = mx.length === 1 && mx[0]?.exchange === '' && mx[0]?.priority === 0;
    const hosts = nullMx ? [] : mx.map((r) => r.exchange).filter((host) => host !== '');
    const hasAddress =
      hosts.length === 0 && !nullMx
        ? (await this.lookup(() => this.resolver.resolve4(domain))).length > 0 ||
          (await this.lookup(() => this.resolver.resolve6(domain))).length > 0
        : false;
    return fromDns({ mx: hosts, nullMx, hasAddress });
  }

  /** No record → empty; a failed lookup (SERVFAIL, timeout) is transient. */
  private async lookup<T>(query: () => Promise<T[]>): Promise<T[]> {
    try {
      return await query();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && NO_DATA.has(code)) return [];
      throw new ExternalServiceError('dns', 'lookup failed', { details: { reason: 'dns', retryable: true } });
    }
  }
}

function dnsResolver(): Resolver {
  return new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
}

/**
 * A verdict from the address alone (tests and E2E, `FAKE_EMAIL_VERIFIER`; refused in production): local parts
 * starting with `invalid`, `catchall`, `risky` or `unknown` get that verdict; anything else is valid.
 */
export class FakeEmailVerifier implements EmailVerifier {
  readonly id = 'reacher' as const;
  /** Addresses checked, in order (tests assert politeness and caching with it). */
  readonly calls: string[] = [];

  async available(): Promise<boolean> {
    return true;
  }

  async verify(email: string): Promise<EmailCheck> {
    this.calls.push(email);
    const local = email.slice(0, email.lastIndexOf('@'));
    const reachable = local.startsWith('invalid')
      ? 'invalid'
      : local.startsWith('catchall') || local.startsWith('risky')
        ? 'risky'
        : local.startsWith('unknown')
          ? 'unknown'
          : 'safe';
    return fromReacher({
      is_reachable: reachable,
      misc: { is_disposable: false, is_role_account: /^(info|contact|hello|bonjour)\b/.test(local) },
      mx: { accepts_mail: reachable !== 'invalid', records: ['mx.example.test.'] },
      smtp: {
        can_connect_smtp: true,
        is_catch_all: local.startsWith('catchall'),
        is_deliverable: reachable === 'safe',
      },
    });
  }
}
