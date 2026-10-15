import { createHash } from 'node:crypto';
import type { Clock, EnrichmentSkipReason, VerificationStatus } from '@bf/contracts';
import { getDomain } from 'tldts';
import type { RecordEmailVerificationCommand } from '../../../business-graph/index.ts';
import type { VerificationOutcome } from '../../application/email-verification.service.ts';
import type { EmailContactReader } from '../../application/ports.ts';
import { guessEmailCandidates, isConclusive } from '../../domain/email-verification.ts';
import {
  type EnrichmentStep,
  type EnrichmentSubject,
  StepDeferredError,
  type StepExecution,
  type StepOutput,
  type StepResult,
} from '../../domain/enrichment-step.ts';

export interface EmailVerifyStepOptions {
  readonly contacts: EmailContactReader;
  readonly verification: {
    verify(organizationId: string, email: string, signal: AbortSignal): Promise<VerificationOutcome>;
  };
  readonly record: Pick<RecordEmailVerificationCommand, 'execute'>;
  /** Feature `emailPatternGuessing` for the workspace (off by default). */
  readonly patternGuessing: (organizationId: string) => Promise<boolean>;
  readonly clock: Clock;
  readonly ttlDays: number;
  /** Estimated cost of one commercial check (budgets are checked against estimates). */
  readonly unitCostUsd: number;
}

const DAY_MS = 24 * 3_600_000;
/** Bounds the work of one run (a site rarely shows more; the contact list is capped at 20 per source). */
const MAX_EMAILS = 40;
const MAX_GUESSES = 9;

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * `email_verify` (BF-028): checks every e-mail contact of the business (after `site_intel`, which finds them) with
 * the workspace's verifier chain, through the shared cache and per-domain politeness, and records the verdicts on
 * the contacts. Re-running is safe: verdicts come back from the cache. When a recipient domain's bucket is empty
 * the step defers itself (no worker waits). With `emailPatternGuessing`, name-pattern candidates are checked and
 * reported in the step output only — never stored as contacts or used for outreach (BF-049 decides).
 */
export class EmailVerifyStep implements EnrichmentStep {
  readonly id = 'email_verify' as const;
  readonly dependsOn = ['site_intel'] as const;
  /** After the crawl (it finds addresses), but addresses known without a website are verified all the same. */
  readonly optionalDependencies = ['site_intel'] as const;
  readonly costCategory = 'provider' as const;
  readonly ttlDays: number;

  constructor(private readonly options: EmailVerifyStepOptions) {
    this.ttlDays = options.ttlDays;
  }

  /** A business without a website or an e-mail has nothing to verify (`site_intel` may still find one). */
  appliesTo(subject: EnrichmentSubject): true | EnrichmentSkipReason {
    return subject.emails.length > 0 || subject.websiteUrl ? true : 'not_applicable';
  }

  /** The addresses known: a new one makes the last output stale. */
  inputHash(subject: EnrichmentSubject): string {
    return hash({ emails: [...subject.emails].sort(), site: subject.websiteUrl }).slice(0, 32);
  }

  /** Upper bound: every known address checked by the commercial verifier (Reacher and DNS cost nothing). */
  estimateCost(subject: EnrichmentSubject): number {
    return Math.min(subject.emails.length, MAX_EMAILS) * this.options.unitCostUsd;
  }

  /** Inconclusive verdicts are re-checked when their (shorter, backed-off) cache entry expires. */
  isStale(last: StepOutput, now: Date): boolean {
    const recheck = last.outputRef?.recheckAt;
    if (typeof recheck === 'string' && Date.parse(recheck) <= now.getTime()) return true;
    return now.getTime() - last.finishedAt.getTime() >= this.ttlDays * DAY_MS;
  }

  async execute(execution: StepExecution): Promise<StepResult> {
    const { subject, organizationId, signal } = execution;
    const contacts = (await this.options.contacts.listForBusiness(subject.businessId)).slice(0, MAX_EMAILS);
    const guessing = await this.guessCandidates(
      subject,
      organizationId,
      contacts.map((c) => c.email),
    );
    if (contacts.length === 0 && guessing.length === 0) {
      return { outcome: 'skipped', reason: 'not_applicable', costUsd: 0 };
    }
    let costUsd = 0;
    let changed = false;
    let recheckAt: Date | null = null;
    const counts: Record<'checked' | 'cached' | 'suppressed' | 'unavailable', number> = {
      checked: 0,
      cached: 0,
      suppressed: 0,
      unavailable: 0,
    };
    const statuses: Partial<Record<VerificationStatus, number>> = {};
    const defer = (retryAfterMs: number) =>
      new StepDeferredError(retryAfterMs, costUsd, changed ? ['contacts'] : [], 'Waiting for a mail domain');

    for (const contact of contacts) {
      signal.throwIfAborted();
      const outcome = await this.options.verification.verify(organizationId, contact.email, signal);
      if (outcome.kind === 'rate_limited') throw defer(outcome.retryAfterMs);
      if (outcome.kind === 'suppressed' || outcome.kind === 'unavailable') {
        counts[outcome.kind] += 1;
        continue;
      }
      costUsd += outcome.costUsd;
      counts[outcome.cached ? 'cached' : 'checked'] += 1;
      statuses[outcome.check.status] = (statuses[outcome.check.status] ?? 0) + 1;
      if (!isConclusive(outcome.check) && (!recheckAt || outcome.expiresAt < recheckAt)) {
        recheckAt = outcome.expiresAt;
      }
      const recorded = await this.options.record.execute(subject.businessId, contact.email, {
        status: outcome.check.status,
        details: outcome.check.details,
        verifiedAt: outcome.checkedAt,
      });
      changed ||= recorded;
    }

    const guessed: Array<{ email: string; status: VerificationStatus }> = [];
    for (const email of guessing) {
      signal.throwIfAborted();
      const outcome = await this.options.verification.verify(organizationId, email, signal);
      if (outcome.kind === 'rate_limited') throw defer(outcome.retryAfterMs);
      if (outcome.kind !== 'verdict') continue;
      costUsd += outcome.costUsd;
      guessed.push({ email, status: outcome.check.status });
    }

    return {
      outcome: 'done',
      costUsd,
      outputRef: {
        ...counts,
        statuses,
        recheckAt: recheckAt?.toISOString() ?? null,
        ...(guessed.length > 0 ? { guessed: guessed.filter((g) => g.status === 'valid') } : {}),
      },
      changedFields: changed ? ['contacts'] : [],
    };
  }

  /** Name-pattern candidates on the business's own domain, when the workspace turned guessing on. */
  private async guessCandidates(
    subject: EnrichmentSubject,
    organizationId: string,
    known: readonly string[],
  ): Promise<string[]> {
    if (!subject.websiteUrl || !(await this.options.patternGuessing(organizationId))) return [];
    let host: string;
    try {
      host = new URL(subject.websiteUrl).hostname;
    } catch {
      return [];
    }
    const domain = getDomain(host);
    if (!domain) return [];
    const names = await this.options.contacts.personNames(subject.businessId);
    const seen = new Set(known);
    return names
      .flatMap((name) => guessEmailCandidates(name, domain))
      .filter((email) => !seen.has(email))
      .slice(0, MAX_GUESSES);
  }
}
