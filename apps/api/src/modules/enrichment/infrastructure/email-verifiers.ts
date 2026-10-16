import { Resolver } from 'node:dns/promises';
import { ExternalServiceError } from '@bf/contracts';
import { BrokenCircuitError, TaskCancelledError } from 'cockatiel';
import type { RateLimiter } from '../../platform/rate-limit/valkey-rate-limiter.ts';
import {
  executeWithSignal,
  policyFor,
  type ResiliencePolicyName,
} from '../../platform/resilience/resilience.ts';
import { isPublicAddress } from '../../platform/security/ip-policy.ts';
import type { ResolvedSecret } from '../../workspace/index.ts';
import type { EmailVerifier } from '../application/ports.ts';
import {
  type EmailCheck,
  fromDns,
  fromReacher,
  fromZeroBounce,
  MailServerBusyError,
} from '../domain/email-verification.ts';

// Verifier adapters of the e-mail chain (BF-028). Their failures are typed `ExternalServiceError`s carrying only a
// sanitized reason — never a provider's free text, never a URL (ZeroBounce takes its key in the query string; the
// telemetry URL redaction keeps it out of traces).

/** Resilience outcomes as the typed, transient errors the engine and the chain understand. */
async function resilient<T>(
  service: string,
  policy: ResiliencePolicyName,
  signal: AbortSignal,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  try {
    return await executeWithSignal(policyFor(policy), signal, call);
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

/**
 * 5xx: transient. 4xx (incl. 429 quota): our request, our key or our quota — retrying soon cannot help, and it must
 * not trip the breaker every workspace shares.
 */
function httpError(service: string, status: number): ExternalServiceError {
  return new ExternalServiceError(service, `answered ${status}`, {
    details: { reason: `HTTP_${status}`, retryable: status >= 500 },
  });
}

const notConfigured = (service: string) =>
  new ExternalServiceError(service, 'is not configured', {
    details: { reason: 'not_configured', retryable: false },
  });

/**
 * At most `limit` tasks at once in this process (SMTP checks are slow and mail servers notice parallel ones). A
 * finished task hands its slot straight to the next waiter; a waiter whose signal aborts leaves the queue.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active < this.limit) this.active += 1;
    else await this.waitForSlot(signal);
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      // Handed over: the slot stays taken by the next task.
      if (next) next();
      else this.active -= 1;
    }
  }

  private waitForSlot(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(granted);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal?.reason);
      };
      const granted = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiting.push(granted);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/**
 * Self-hosted Reacher (`check-if-email-exists` backend, compose profile `verify`): `POST /v1/check_email`. It talks
 * SMTP to the recipient's mail server, so it needs outbound port 25 (see the SMTP port diagnostic). Always used
 * behind `PoliteMailServerVerifier`.
 */
export class ReacherVerifier implements EmailVerifier {
  readonly id = 'reacher' as const;
  private readonly slots: Semaphore;

  constructor(
    private readonly baseUrl: string | undefined,
    concurrency: number,
    /** Reacher's `RCH__HEADER_SECRET`, sent as `x-reacher-secret` (only the API may call it). */
    private readonly headerSecret?: string,
  ) {
    this.slots = new Semaphore(concurrency);
  }

  async available(): Promise<boolean> {
    return Boolean(this.baseUrl);
  }

  verify(email: string, context: { readonly signal: AbortSignal }): Promise<EmailCheck> {
    const baseUrl = this.baseUrl;
    if (!baseUrl) return Promise.reject(notConfigured('reacher'));
    return this.slots.run(
      () =>
        resilient('reacher', 'reacher', context.signal, async (signal) => {
          const response = await fetch(new URL('/v1/check_email', baseUrl), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(this.headerSecret ? { 'x-reacher-secret': this.headerSecret } : {}),
            },
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
      context.signal,
    );
  }
}

/** The lookups mail-server checks make (`node:dns` `Resolver` in production). */
export interface MailDns {
  resolveMx(domain: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

const DNS_TIMEOUT_MS = 3_000;
/** DNS answers meaning "no such record" (as opposed to a failed lookup). */
const NO_DATA = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);
/** MX hosts checked for their addresses (a domain rarely has more). */
const MAX_MAIL_HOSTS = 5;

export function dnsResolver(): MailDns {
  return new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
}

/** No record → empty; a failed lookup (SERVFAIL, timeout) is transient. */
async function lookup<T>(query: () => Promise<T[]>): Promise<T[]> {
  try {
    return await query();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && NO_DATA.has(code)) return [];
    throw new ExternalServiceError('dns', 'lookup failed', { details: { reason: 'dns', retryable: true } });
  }
}

/** Mail hosts of a domain by preference (`[]` for a null MX), else the domain itself (implicit MX). */
async function mailHosts(dns: MailDns, domain: string): Promise<string[]> {
  const mx = await lookup(() => dns.resolveMx(domain));
  if (mx.length === 1 && mx[0]?.exchange === '') return [];
  const hosts = [...mx]
    .sort((a, b) => a.priority - b.priority)
    .map((r) => r.exchange.toLowerCase().replace(/\.$/, ''))
    .filter((host) => host !== '');
  return hosts.length > 0 ? [...new Set(hosts)].slice(0, MAX_MAIL_HOSTS) : [domain];
}

export interface PolitenessOptions {
  readonly dns: MailDns;
  readonly limiter: RateLimiter;
  /** Checks per mail server per minute, all workspaces together. */
  readonly perMinute: number;
  /** Address policy (tests may relax it for documentation addresses). */
  readonly isPublic?: (ip: string) => boolean;
}

/**
 * Decorator around verifiers that talk to recipients' mail servers (Reacher): resolves the domain's mail hosts
 * itself and refuses any that is not a public address (a crawled domain must not point our SMTP client at internal
 * services), then takes a token from the mail server's bucket — a workspace's own share first (half the rate), then
 * the server's — so no tenant can starve the others. An empty bucket throws `MailServerBusyError`: nothing is asked.
 */
export class PoliteMailServerVerifier implements EmailVerifier {
  readonly id: EmailVerifier['id'];

  constructor(
    private readonly inner: EmailVerifier,
    private readonly options: PolitenessOptions,
  ) {
    this.id = inner.id;
  }

  available(organizationId: string, context?: { readonly pendingUsd?: number }): Promise<boolean> {
    return this.inner.available(organizationId, context);
  }

  async verify(
    email: string,
    context: { readonly organizationId: string; readonly signal: AbortSignal },
  ): Promise<EmailCheck> {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    const hosts = await mailHosts(this.options.dns, domain);
    const isPublic = this.options.isPublic ?? isPublicAddress;
    for (const host of hosts) {
      const addresses = [
        ...(await lookup(() => this.options.dns.resolve4(host))),
        ...(await lookup(() => this.options.dns.resolve6(host))),
      ];
      if (addresses.some((ip) => !isPublic(ip))) {
        throw new ExternalServiceError(this.inner.id, 'mail server address not allowed', {
          details: { reason: 'private_address', retryable: false },
        });
      }
    }
    // A domain without mail hosts is answered without contacting anyone.
    const server = hosts[0];
    if (server) await this.takeToken(context.organizationId, server);
    return this.inner.verify(email, context);
  }

  private async takeToken(organizationId: string, server: string): Promise<void> {
    const perMinute = this.options.perMinute;
    const own = await this.options.limiter.tryTake(`email-verify:org:${organizationId}:mx:${server}`, {
      capacity: 1,
      perSecond: perMinute / 2 / 60,
    });
    if (own > 0) throw new MailServerBusyError(own);
    const shared = await this.options.limiter.tryTake(`email-verify:mx:${server}`, {
      capacity: Math.min(2, Math.max(1, Math.floor(perMinute))),
      perSecond: perMinute / 60,
    });
    if (shared > 0) throw new MailServerBusyError(shared);
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
    /** Whether the workspace's enrichment budget can still pay one check (a paid call is never made past it). */
    private readonly canSpend: (organizationId: string, usd: number) => Promise<boolean>,
    private readonly baseUrl: string = ZEROBOUNCE_BASE_URL,
  ) {}

  /** With a key, and while the budget can pay one more check on top of what the step already spent. */
  async available(organizationId: string, context: { readonly pendingUsd?: number } = {}): Promise<boolean> {
    if ((await this.key(organizationId)) === undefined) return false;
    return this.canSpend(organizationId, this.unitCostUsd + (context.pendingUsd ?? 0));
  }

  async verify(
    email: string,
    context: { readonly organizationId: string; readonly signal: AbortSignal },
  ): Promise<EmailCheck> {
    const secret = await this.key(context.organizationId);
    if (!secret) throw notConfigured('zerobounce');
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

  /**
   * Connection test (Settings → Integrations): whether ZeroBounce accepts the key (`-1` credits for an unknown key).
   * The balance is not shown: with the deployment's fallback key it is the operator's account.
   */
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
    return {
      ok: true,
      message: credits > 0 ? 'ZeroBounce accepted the key.' : 'The key works but has no credits left.',
    };
  }
}

/** DNS only (syntax was checked when the contact was stored): MX, null MX, implicit MX — never a mailbox check. */
export class DnsMxVerifier implements EmailVerifier {
  readonly id = 'dns' as const;

  constructor(private readonly resolver: MailDns = dnsResolver()) {}

  async available(): Promise<boolean> {
    return true;
  }

  async verify(email: string): Promise<EmailCheck> {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    const mx = await lookup(() => this.resolver.resolveMx(domain));
    const nullMx = mx.length === 1 && mx[0]?.exchange === '' && mx[0]?.priority === 0;
    const hosts = nullMx ? [] : mx.map((r) => r.exchange).filter((host) => host !== '');
    const hasAddress =
      hosts.length === 0 && !nullMx
        ? (await lookup(() => this.resolver.resolve4(domain))).length > 0 ||
          (await lookup(() => this.resolver.resolve6(domain))).length > 0
        : false;
    return fromDns({ mx: hosts, nullMx, hasAddress });
  }
}

/** DNS for tests and E2E (`FAKE_EMAIL_VERIFIER`): every domain has `mx.example.test`; nothing is looked up. */
export const FAKE_MAIL_DNS: MailDns = {
  resolveMx: async () => [{ exchange: 'mx.example.test', priority: 10 }],
  resolve4: async () => ['192.0.2.25'],
  resolve6: async () => [],
};

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
