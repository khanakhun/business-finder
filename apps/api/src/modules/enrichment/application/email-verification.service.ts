import type { ApiEnv } from '@bf/config';
import type { Clock, EmailVerifierId } from '@bf/contracts';
import { type Logger, metrics, startSpan } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { EmailAddress, isDisposableDomain } from '../../business-graph/index.ts';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import { isTransient } from '../../platform/resilience/resilience.ts';
import { WorkspaceDefaults } from '../../workspace/index.ts';
import {
  chainOrder,
  checksMailbox,
  disposableByClassification,
  type EmailCheck,
  isConclusive,
  MailServerBusyError,
  verdictTtlDays,
} from '../domain/email-verification.ts';
import {
  type CachedVerdict,
  EMAIL_SUPPRESSION,
  EMAIL_VERDICT_CACHE,
  EMAIL_VERIFIER_LIST,
  type EmailSuppressionCheck,
  type EmailVerdictCache,
  type EmailVerifier,
} from './ports.ts';

const DAY_MS = 24 * 3_600_000;

const verifications = () =>
  metrics.counter({
    name: 'bf_email_verifications_total',
    help: 'E-mail verdicts, by what produced them and status (cache hits included)',
    labelNames: ['via', 'status', 'cached'],
  });
const verifierFailures = () =>
  metrics.counter({
    name: 'bf_email_verifier_failures_total',
    help: 'E-mail verifier calls that failed (the chain moved on), by verifier',
    labelNames: ['verifier'],
  });

export type VerificationOutcome =
  /** A verdict, fresh from the chain or from the cache (`costUsd` is 0 then). */
  | {
      readonly kind: 'verdict';
      readonly check: EmailCheck;
      readonly checkedAt: Date;
      readonly expiresAt: Date;
      readonly cached: boolean;
      readonly costUsd: number;
      /**
       * Inconclusive only because a verifier that could have answered failed transiently (down, timed out): not
       * cached, to be asked again soon. Recording it is safe — a conclusive verdict is never downgraded.
       */
      readonly provisional?: boolean;
    }
  /** On a suppression list: not checked (BF-049). */
  | { readonly kind: 'suppressed' }
  /** The recipient's mail server was asked recently: try again in `retryAfterMs`. */
  | { readonly kind: 'rate_limited'; readonly retryAfterMs: number }
  /** No verifier of the workspace's chain can be used here. */
  | { readonly kind: 'unavailable' };

export interface VerifyOptions {
  /** Keep the verdict in the shared cache (default). Name-pattern guesses are never cached. */
  readonly cache?: boolean;
  /** What the calling step already spent and has not booked yet (paid verifiers check the budget with it). */
  readonly pendingUsd?: number;
}

/**
 * Verifies one address (BF-028) — suppression first, then the shared cache, the address's own classification
 * (a disposable domain needs no check), and the workspace's verifier chain (Chain of Responsibility: the first
 * conclusive verdict wins). Verifiers that talk to recipients' mail servers are wrapped in a politeness decorator
 * (per mail server, with a per-workspace share). Conclusive verdicts are cached for the TTL, inconclusive ones with
 * backoff. When a verifier failed transiently and nothing conclusive came, the inconclusive answer is returned as
 * `provisional` and not cached (nobody inherits an outage's `unknown`); contacts never downgrade a known verdict.
 */
@Injectable()
export class EmailVerificationService {
  private readonly verifiers: ReadonlyMap<EmailVerifierId, EmailVerifier>;

  constructor(
    @Inject(EMAIL_VERIFIER_LIST) verifiers: readonly EmailVerifier[],
    @Inject(EMAIL_VERDICT_CACHE) private readonly cache: EmailVerdictCache,
    @Inject(EMAIL_SUPPRESSION) private readonly suppression: EmailSuppressionCheck,
    private readonly defaults: WorkspaceDefaults,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.verifiers = new Map(verifiers.map((v) => [v.id, v]));
  }

  verify(
    organizationId: string,
    email: string,
    signal: AbortSignal,
    options: VerifyOptions = {},
  ): Promise<VerificationOutcome> {
    return startSpan('enrichment.email_verify', { 'bf.org_id': organizationId }, async (span) => {
      const outcome = await this.run(
        organizationId,
        email.trim().toLowerCase(),
        signal,
        options.cache ?? true,
        options.pendingUsd ?? 0,
      );
      span.setAttribute('bf.email_verify.outcome', outcome.kind);
      if (outcome.kind === 'verdict') {
        verifications().inc({
          via: outcome.check.details.checkedVia,
          status: outcome.check.status,
          cached: String(outcome.cached),
        });
      }
      return outcome;
    });
  }

  private async run(
    organizationId: string,
    address: string,
    signal: AbortSignal,
    useCache: boolean,
    pendingUsd: number,
  ): Promise<VerificationOutcome> {
    const domain = address.slice(address.lastIndexOf('@') + 1);
    if (await this.suppression.isSuppressed(organizationId, address)) return { kind: 'suppressed' };
    const now = this.clock.now();
    const chain = await this.usableChain(organizationId, pendingUsd);
    const cached = useCache ? await this.cache.get(address) : undefined;
    if (cached && cached.expiresAt > now && this.reusable(cached, chain)) {
      return {
        kind: 'verdict',
        check: cached.check,
        checkedAt: cached.checkedAt,
        expiresAt: cached.expiresAt,
        cached: true,
        costUsd: 0,
      };
    }
    if (isDisposableDomain(domain)) {
      return this.store(address, disposableByClassification(roleAccount(address)), cached, 0, useCache);
    }

    let best: EmailCheck | undefined;
    let spent = 0;
    let transientFailure: unknown;
    let lastError: unknown;
    for (const verifier of chain) {
      try {
        const check = await verifier.verify(address, { organizationId, signal });
        spent += check.costUsd;
        // Any answer beats none; a later verifier's inconclusive answer does not replace an earlier one.
        best ??= check;
        if (isConclusive(check)) {
          best = check;
          break;
        }
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof MailServerBusyError)
          return { kind: 'rate_limited', retryAfterMs: error.retryAfterMs };
        // The next verifier may still answer (port 25 blocked, Reacher down, quota reached…). Never the address.
        verifierFailures().inc({ verifier: verifier.id });
        this.logger.warn({ err: error, verifier: verifier.id, organizationId }, 'e-mail verifier failed');
        if (isTransient(error)) transientFailure ??= error;
        lastError = error;
      }
    }
    if (best && !isConclusive(best) && transientFailure) {
      // A verifier that could have answered is down: not cached (nobody else inherits it), asked again soon.
      return { ...(await this.store(address, best, cached, spent, false)), provisional: true };
    }
    if (!best) {
      if (lastError) throw lastError;
      return { kind: 'unavailable' };
    }
    return this.store(address, best, cached, spent, useCache);
  }

  /** The workspace's chain: verifiers this deployment has and the workspace can use, in its order. */
  private async usableChain(organizationId: string, pendingUsd: number): Promise<EmailVerifier[]> {
    const settings = await this.defaults.enrichmentSettings(organizationId);
    const chain: EmailVerifier[] = [];
    for (const id of chainOrder(settings.emailVerifiers, new Set(this.verifiers.keys()))) {
      const verifier = this.verifiers.get(id);
      if (verifier && (await verifier.available(organizationId, { pendingUsd }))) chain.push(verifier);
    }
    return chain;
  }

  /**
   * A cached verdict stands for this workspace unless it is an inconclusive DNS-only one and the workspace can ask
   * the mailbox itself (a DNS-only workspace must not hide a real check from others).
   */
  private reusable(cached: CachedVerdict, chain: readonly EmailVerifier[]): boolean {
    if (isConclusive(cached.check) || checksMailbox(cached.check.details.checkedVia)) return true;
    return !chain.some((verifier) => checksMailbox(verifier.id));
  }

  private async store(
    email: string,
    check: EmailCheck,
    previous: CachedVerdict | undefined,
    costUsd: number,
    useCache: boolean,
  ): Promise<Extract<VerificationOutcome, { kind: 'verdict' }>> {
    const checkedAt = this.clock.now();
    const streak = isConclusive(check)
      ? 0
      : previous && !isConclusive(previous.check)
        ? previous.inconclusiveStreak + 1
        : 1;
    const ttlDays = verdictTtlDays(check, streak, (this.env as ApiEnv).ENRICHMENT_TTL_EMAIL_VERIFY_DAYS);
    const expiresAt = new Date(checkedAt.getTime() + ttlDays * DAY_MS);
    if (useCache) {
      await this.cache.put(email, {
        check: { ...check, costUsd },
        checkedAt,
        expiresAt,
        inconclusiveStreak: streak,
      });
    }
    return { kind: 'verdict', check, checkedAt, expiresAt, cached: false, costUsd };
  }
}

/** Whether the address is a shared mailbox (generic or department), as far as its local part says. */
function roleAccount(address: string): boolean {
  try {
    const { subtype } = EmailAddress.parse(address);
    return subtype === 'generic' || subtype === 'department';
  } catch {
    return false;
  }
}
