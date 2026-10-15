import type { EnrichmentStepId } from '@bf/contracts';
import { Injectable } from '@nestjs/common';
import type { EnrichmentStep } from '../domain/enrichment-step.ts';

/**
 * The steps this deployment can run (Registry): modules register theirs at start-up (`site_intel` here; email
 * verification, reviews, PageSpeed and the visual audit in their tickets). The engine only reads it.
 */
@Injectable()
export class StepRegistry {
  private readonly steps = new Map<EnrichmentStepId, EnrichmentStep>();

  register(step: EnrichmentStep): void {
    if (this.steps.has(step.id)) throw new Error(`Enrichment step ${step.id} is already registered`);
    this.steps.set(step.id, step);
  }

  get(id: EnrichmentStepId): EnrichmentStep | undefined {
    return this.steps.get(id);
  }

  all(): ReadonlyMap<EnrichmentStepId, EnrichmentStep> {
    return this.steps;
  }
}
