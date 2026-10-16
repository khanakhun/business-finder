import {
  type BulkEnrichResponse,
  type Clock,
  DiscoveryBusinessFound,
  type DomainEvent,
  type EnrichmentStepId,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { OnDomainEvent } from '../../platform/events/on-domain-event.decorator.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import { WorkspaceDefaults } from '../../workspace/index.ts';
import { StartEnrichmentCommand } from './enrichment.use-cases.ts';
import {
  EMAIL_VERDICT_CACHE,
  type EmailVerdictCache,
  ENRICHMENT_REPOSITORY,
  type EnrichmentRepository,
} from './ports.ts';
import { StepRegistry } from './step-registry.ts';

const DAY_MS = 24 * 3_600_000;
/** Candidates looked at per run the cap allows (some have nothing to do: a step that does not apply). */
const CANDIDATE_FACTOR = 3;

/** `POST /v1/enrichment/bulk`: one run per business (each idempotent per request key and business). */
@Injectable()
export class BulkEnrichCommand {
  constructor(private readonly start: StartEnrichmentCommand) {}

  async execute(
    organizationId: string,
    requestedBy: string | null,
    input: {
      readonly businessIds: readonly string[];
      readonly steps?: readonly EnrichmentStepId[];
      readonly force: boolean;
      readonly idempotencyKey: string | null;
    },
  ): Promise<BulkEnrichResponse> {
    const response: { runs: BulkEnrichResponse['runs']; rejected: BulkEnrichResponse['rejected'] } = {
      runs: [],
      rejected: [],
    };
    for (const businessId of input.businessIds) {
      const outcome = await this.start.execute({
        organizationId,
        businessId,
        requestedBy,
        trigger: 'bulk',
        ...(input.steps ? { steps: input.steps } : {}),
        force: input.force,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${businessId}` : null,
      });
      if (outcome.kind === 'rejected') response.rejected.push({ businessId, reason: outcome.reason });
      else response.runs.push({ businessId, runId: outcome.run.id });
    }
    return response;
  }
}

/** Discovery runs that asked for it enrich the businesses they add (BF-020 `autoEnrich`). */
@Injectable()
export class AutoEnrichSubscriber {
  constructor(private readonly start: StartEnrichmentCommand) {}

  @OnDomainEvent(DiscoveryBusinessFound, { id: 'enrichment.auto-enrich' })
  async onFound(event: DomainEvent<typeof DiscoveryBusinessFound>): Promise<void> {
    if (!event.orgId) return;
    await this.start.execute({
      organizationId: event.orgId,
      businessId: event.payload.businessId,
      requestedBy: null,
      trigger: 'discovery',
      force: false,
      idempotencyKey: `discovery:${event.payload.runId}:${event.payload.businessId}`,
    });
  }
}

/**
 * Nightly refresh (one job per UTC day): each workspace re-enriches the tracked businesses with a stale step (per
 * the registered steps' TTLs), least recently enriched first, up to its nightly cap. Runs go through the same command (budgets, one open run per
 * business), keyed per day so a retried job starts nothing twice.
 */
@Injectable()
export class NightlyRefresh {
  constructor(
    @Inject(ENRICHMENT_REPOSITORY) private readonly runs: EnrichmentRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly start: StartEnrichmentCommand,
    private readonly defaults: WorkspaceDefaults,
    private readonly registry: StepRegistry,
    @Inject(EMAIL_VERDICT_CACHE) private readonly verdicts: EmailVerdictCache,
  ) {}

  async run(day: string): Promise<{ readonly started: number }> {
    const now = this.clock.now().getTime();
    // Retention: e-mail verdicts expired for a full TTL (BF-028). Recently expired ones are kept: their inconclusive
    // streak drives the re-check backoff (1, 2, 4… days).
    const verdictTtlDays = this.registry.get('email_verify')?.ttlDays ?? 60;
    const purged = await this.verdicts.purgeExpired(new Date(now - verdictTtlDays * DAY_MS));
    if (purged > 0) this.logger.info({ purged }, 'expired e-mail verdicts purged');
    // Every registered step, with its own freshness: later steps are refreshed without changing this code.
    const steps = [...this.registry.all().values()].map((step) => ({
      step: step.id,
      staleBefore: new Date(now - step.ttlDays * DAY_MS),
    }));
    if (steps.length === 0) return { started: 0 };
    let started = 0;
    for (const organizationId of await this.runs.trackingOrganizations()) {
      const { nightlyRefreshLimit } = await this.defaults.enrichmentSettings(organizationId);
      // A retried job (same day) counts what it already started.
      const already = await this.runs.countRunsSince(
        organizationId,
        'schedule',
        new Date(`${day}T00:00:00.000Z`),
      );
      const limit = nightlyRefreshLimit - already;
      if (limit <= 0) continue;
      // Some candidates turn out to have nothing to do (a step that does not apply): look a little further.
      const candidates = await this.runs.refreshCandidates(
        organizationId,
        steps,
        limit * CANDIDATE_FACTOR,
        new Date(now),
      );
      let startedHere = 0;
      for (const businessId of candidates) {
        if (startedHere >= limit) break;
        const outcome = await this.start.execute({
          organizationId,
          businessId,
          requestedBy: null,
          trigger: 'schedule',
          force: false,
          idempotencyKey: `schedule:${day}:${businessId}`,
        });
        if (outcome.kind === 'started') startedHere += 1;
        // The monthly budget ran out, or the workspace has too much waiting: stop for tonight.
        if (outcome.kind === 'rejected' && (outcome.reason === 'budget' || outcome.reason === 'busy')) break;
      }
      started += startedHere;
    }
    this.logger.info({ day, started }, 'nightly enrichment refresh');
    return { started };
  }
}
