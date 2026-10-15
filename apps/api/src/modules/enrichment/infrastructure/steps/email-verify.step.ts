import { createHash } from 'node:crypto';
import type { Clock, EnrichmentSkipReason, VerificationStatus } from '@bf/contracts';
import { getDomain } from 'tldts';
import {
  type EmailContactsQuery,
  type EmailContactView,
  isFreeMailDomain,
  type RecordEmailVerificationCommand,
} from '../../../business-graph/index.ts';
import { isTransient } from '../../../platform/resilience/resilience.ts';
import type { VerificationOutcome, VerifyOptions } from '../../application/email-verification.service.ts';
import type { PersonalAddressPolicy } from '../../application/ports.ts';
import { guessEmailCandidates, isConclusive } from '../../domain/email-verification.ts';
import {
  type EnrichmentStep,
  type EnrichmentSubject,
  StepDeferredError,
  type StepExecution,
  StepInterruptedError,
  type StepOutput,
  type StepResult,
} from '../../domain/enrichment-step.ts';

export interface EmailVerifyStepOptions {
  readonly contacts: Pick<EmailContactsQuery, 'listForBusiness' | 'personNames'>;
  readonly verification: {
    verify(
      organizationId: string,
      email: string,
      signal: AbortSignal,
      options?: VerifyOptions,
    ): Promise<VerificationOutcome>;
  };
  readonly record: Pick<RecordEmailVerificationCommand, 'execute'>;
  /** Feature `emailPatternGuessing` for the workspace (off by default). */
  readonly patternGuessing: (organizationId: string) => Promise<boolean>;
  /** Whether personal addresses may be contacted for the business (deny-all until BF-049). */
  readonly personalAddresses: PersonalAddressPolicy;
  readonly clock: Clock;
  readonly ttlDays: number;
  /** Estimated cost of one commercial check (budgets are checked against estimates). */
  readonly unitCostUsd: number;
}

const DAY_MS = 24 * 3_600_000;
/** Bounds the work of one run (a site rarely shows more; a website source carries at most 20). */
const MAX_EMAILS = 40;
/** Addresses a crawl may still add (a website source carries at most 20 e-mails): budgeted up front. */
const SITE_EMAILS = 20;
const MAX_GUESSES = 9;
/** Waits for busy mail servers before the step finishes with what it could check (the rest is re-checked later). */
export const MAX_DEFERRALS = 6;

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

type Counts = Record<'checked' | 'cached' | 'suppressed' | 'unavailable' | 'rateLimited' | 'failed', number>;

/**
 * `email_verify` (BF-028): checks every e-mail contact of the business (after `site_intel`, which finds them — an
 * optional dependency) with the workspace's verifier chain, and records the verdicts on the contacts. Re-running is
 * safe: verdicts come back from the cache. One address's permanent failure never stops the others; a transient one
 * stops the step (the engine retries) after booking what was already spent. Addresses whose mail server is busy are
 * left for last: the step defers itself once for all of them (up to `MAX_DEFERRALS` times), then finishes and asks
 * for a re-check. Name-pattern guessing (flag `emailPatternGuessing`) only runs where personal addresses may be
 * contacted; guesses are never cached or stored — only counted.
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

  /**
   * Upper bound: every address checked by the commercial verifier — the known ones, or as many as a crawl can add
   * when the business has a website (Reacher and DNS cost nothing).
   */
  estimateCost(subject: EnrichmentSubject): number {
    const addresses = subject.websiteUrl
      ? Math.max(subject.emails.length, SITE_EMAILS)
      : subject.emails.length;
    return Math.min(addresses, MAX_EMAILS) * this.options.unitCostUsd;
  }

  /** Inconclusive or postponed checks are due again at `recheckAt` (picked up by the nightly refresh too). */
  isStale(last: StepOutput, now: Date): boolean {
    const recheck = last.outputRef?.recheckAt;
    if (typeof recheck === 'string' && Date.parse(recheck) <= now.getTime()) return true;
    return now.getTime() - last.finishedAt.getTime() >= this.ttlDays * DAY_MS;
  }

  async execute(execution: StepExecution): Promise<StepResult> {
    const { subject, organizationId, signal } = execution;
    const contacts = (await this.options.contacts.listForBusiness(subject.businessId)).slice(0, MAX_EMAILS);
    const guesses = await this.guessCandidates(execution, contacts);
    if (contacts.length === 0 && guesses.length === 0) {
      return { outcome: 'skipped', reason: 'not_applicable', costUsd: 0 };
    }
    const now = this.options.clock.now();
    const counts: Counts = {
      checked: 0,
      cached: 0,
      suppressed: 0,
      unavailable: 0,
      rateLimited: 0,
      failed: 0,
    };
    const statuses: Partial<Record<VerificationStatus, number>> = {};
    const waits: number[] = [];
    let costUsd = 0;
    let changed = false;
    let recheckAt: number | null = null;
    const earliest = (at: number) => {
      recheckAt = recheckAt === null ? at : Math.min(recheckAt, at);
    };
    const changedFields = () => (changed ? ['contacts'] : []);
    const interrupted = (error: unknown) =>
      costUsd > 0 || changed ? new StepInterruptedError(error, costUsd, changedFields()) : error;

    for (const contact of contacts) {
      signal.throwIfAborted();
      let outcome: VerificationOutcome;
      try {
        outcome = await this.options.verification.verify(organizationId, contact.email, signal);
      } catch (error) {
        // Transient: the engine retries (or the run stops) — money already spent is booked first.
        if (signal.aborted || isTransient(error)) throw interrupted(error);
        counts.failed += 1;
        continue;
      }
      if (outcome.kind === 'rate_limited') {
        counts.rateLimited += 1;
        waits.push(outcome.retryAfterMs);
        continue;
      }
      if (outcome.kind === 'suppressed' || outcome.kind === 'unavailable') {
        counts[outcome.kind] += 1;
        continue;
      }
      costUsd += outcome.costUsd;
      counts[outcome.cached ? 'cached' : 'checked'] += 1;
      statuses[outcome.check.status] = (statuses[outcome.check.status] ?? 0) + 1;
      if (!isConclusive(outcome.check)) earliest(outcome.expiresAt.getTime());
      const recorded = await this.options.record.execute(subject.businessId, contact.email, {
        status: outcome.check.status,
        details: outcome.check.details,
        verifiedAt: outcome.checkedAt,
      });
      changed ||= recorded;
    }

    if (waits.length > 0) {
      const wait = Math.min(...waits);
      if (execution.deferrals < MAX_DEFERRALS) {
        throw new StepDeferredError(wait, costUsd, changedFields(), 'Waiting for busy mail servers');
      }
      // Waited long enough: finish with what could be checked; the rest is due again soon.
      earliest(now.getTime() + wait);
    }

    let guessedValid = 0;
    for (const email of guesses) {
      signal.throwIfAborted();
      let outcome: VerificationOutcome;
      try {
        outcome = await this.options.verification.verify(organizationId, email, signal, { cache: false });
      } catch (error) {
        if (signal.aborted || isTransient(error)) throw interrupted(error);
        continue;
      }
      if (outcome.kind !== 'verdict') continue;
      costUsd += outcome.costUsd;
      if (outcome.check.status === 'valid') guessedValid += 1;
    }

    const due: number | null = recheckAt;
    return {
      outcome: 'done',
      costUsd,
      outputRef: {
        ...counts,
        statuses,
        recheckAt: due === null ? null : new Date(due).toISOString(),
        // Counts only: guessed addresses are personal data and are not kept (BF-049 decides their use).
        ...(guesses.length > 0 ? { guessed: guesses.length, guessedValid } : {}),
      },
      changedFields: changedFields(),
    };
  }

  /**
   * Name-pattern candidates on the business's own mail domain, only where the workspace turned guessing on AND
   * personal addresses may be contacted. The domain must already carry one of the business's published addresses
   * (a hosting platform's domain never does) and must not be webmail.
   */
  private async guessCandidates(
    execution: StepExecution,
    contacts: readonly EmailContactView[],
  ): Promise<string[]> {
    const { subject, organizationId } = execution;
    if (!subject.websiteUrl || !(await this.options.patternGuessing(organizationId))) return [];
    if (!(await this.options.personalAddresses.allowsPersonalAddresses(organizationId, subject.businessId))) {
      return [];
    }
    let host: string;
    try {
      host = new URL(subject.websiteUrl).hostname;
    } catch {
      return [];
    }
    const domain = getDomain(host, { allowPrivateDomains: true });
    if (!domain || isFreeMailDomain(domain)) return [];
    const onDomain = contacts.some(
      (c) => getDomain(c.email.slice(c.email.lastIndexOf('@') + 1), { allowPrivateDomains: true }) === domain,
    );
    if (!onDomain) return [];
    const names = await this.options.contacts.personNames(subject.businessId);
    const known = new Set(contacts.map((c) => c.email));
    return names
      .flatMap((name) => guessEmailCandidates(name, domain))
      .filter((email) => !known.has(email))
      .slice(0, MAX_GUESSES);
  }
}
