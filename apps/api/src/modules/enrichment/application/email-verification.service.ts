import type { ApiEnv } from '@bf/config';
import type { Clock, EmailVerifierId } from '@bf/contracts';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { isDisposableDomain } from '../../business-graph/index.ts';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { RATE_LIMITER, type RateLimiter } from '../../platform/rate-limit/valkey-rate-limiter.ts';
import { WorkspaceDefaults } from '../../workspace/index.ts';
import {
  chainOrder,
  disposableByClassification,
  type EmailCheck,
  isConclusive,
  verdictTtlDays,
  withClassification,
} from '../domain/email-verification.ts';
import {
  EMAIL_SUPPRESSION,
  EMAIL_VERDICT_CACHE,
  EMAIL_VERIFIER_LIST,
  type EmailSuppressionCheck,
  type EmailVerdictCache,
  type EmailVerifier,
} from './ports.ts';

const DAY_MS = 24 * 3_600_000;

export type VerificationOutcome =
  /** A verdict, fresh from the chain or from the cache (`costUsd` is 0 then). */
  | {
      readonly kind: 'verdict';
      readonly check: EmailCheck;
      readonly checkedAt: Date;
      readonly expiresAt: Date;
      readonly cached: boolean;
      readonly costUsd: number;
    }
  /** On a suppression list: not checked (BF-049). */
  | { readonly kind: 'suppressed' }
  /** The recipient domain's politeness bucket is empty: try again in `retryAfterMs`. */
  | { readonly kind: 'rate_limited'; readonly retryAfterMs: number }
  /** No verifier of the workspace's chain can be used here. */
  | { readonly kind: 'unavailable' };

/**
 * Verifies one address (BF-028) — suppression first, then the shared cache, the address's own classification
 * (a disposable domain needs no check), the recipient domain's politeness bucket, and finally the workspace's
 * verifier chain (Chain of Responsibility: the first conclusive verdict wins; an inconclusive one is kept in case
 * nothing better comes). Every verdict is cached: conclusive ones for the TTL, inconclusive ones with backoff.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);
  private readonly verifiers: ReadonlyMap<EmailVerifierId, EmailVerifier>;

  constructor(
    @Inject(EMAIL_VERIFIER_LIST) verifiers: readonly EmailVerifier[],
    @Inject(EMAIL_VERDICT_CACHE) private readonly cache: EmailVerdictCache,
    @Inject(EMAIL_SUPPRESSION) private readonly suppression: EmailSuppressionCheck,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    private readonly defaults: WorkspaceDefaults,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {
    this.verifiers = new Map(verifiers.map((v) => [v.id, v]));
  }

  async verify(organizationId: string, email: string, signal: AbortSignal): Promise<VerificationOutcome> {
    const address = email.trim().toLowerCase();
    const domain = address.slice(address.lastIndexOf('@') + 1);
    if (await this.suppression.isSuppressed(organizationId, address)) return { kind: 'suppressed' };
    const cached = await this.cache.get(address);
    const now = this.clock.now();
    if (cached && cached.expiresAt > now) {
      return {
        kind: 'verdict',
        check: cached.check,
        checkedAt: cached.checkedAt,
        expiresAt: cached.expiresAt,
        cached: true,
        costUsd: 0,
      };
    }
    const disposable = isDisposableDomain(domain);
    if (disposable) return this.store(address, disposableByClassification(false), cached, 0);

    const env = this.env as ApiEnv;
    const perMinute = env.EMAIL_VERIFY_PER_DOMAIN_PER_MINUTE;
    const waitMs = await this.limiter.tryTake(`email-verify:${domain}`, {
      capacity: Math.max(1, Math.floor(perMinute)),
      perSecond: perMinute / 60,
    });
    if (waitMs > 0) return { kind: 'rate_limited', retryAfterMs: waitMs };

    const settings = await this.defaults.enrichmentSettings(organizationId);
    let best: EmailCheck | undefined;
    let spent = 0;
    let lastError: unknown;
    for (const id of chainOrder(settings.emailVerifiers, new Set(this.verifiers.keys()))) {
      const verifier = this.verifiers.get(id);
      if (!verifier || !(await verifier.available(organizationId))) continue;
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
        // The next verifier may still answer (port 25 blocked, Reacher down, quota reached…).
        this.logger.warn({ err: error, verifier: id }, 'e-mail verifier failed; trying the next one');
        lastError = error;
      }
    }
    if (!best) {
      // Every usable verifier failed: the caller retries (transient) — nothing is cached.
      if (lastError) throw lastError;
      return { kind: 'unavailable' };
    }
    return this.store(address, withClassification(best, disposable), cached, spent);
  }

  private async store(
    email: string,
    check: EmailCheck,
    previous: { readonly check: EmailCheck; readonly inconclusiveStreak: number } | undefined,
    costUsd: number,
  ): Promise<VerificationOutcome> {
    const checkedAt = this.clock.now();
    const streak = isConclusive(check)
      ? 0
      : previous && !isConclusive(previous.check)
        ? previous.inconclusiveStreak + 1
        : 1;
    const ttlDays = verdictTtlDays(check, streak, (this.env as ApiEnv).ENRICHMENT_TTL_EMAIL_VERIFY_DAYS);
    const expiresAt = new Date(checkedAt.getTime() + ttlDays * DAY_MS);
    await this.cache.put(email, {
      check: { ...check, costUsd },
      checkedAt,
      expiresAt,
      inconclusiveStreak: streak,
    });
    return { kind: 'verdict', check, checkedAt, expiresAt, cached: false, costUsd };
  }
}
