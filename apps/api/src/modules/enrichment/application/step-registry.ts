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

  /**
   * Swaps a registered step for another with the same id — tests script engine behaviour (fail, block, cost) on real
   * step ids once every id has a real step (BF-030). Production code registers, never replaces.
   */
  replace(step: EnrichmentStep): void {
    if (!this.steps.has(step.id)) throw new Error(`Enrichment step ${step.id} is not registered`);
    this.steps.set(step.id, step);
  }

  get(id: EnrichmentStepId): EnrichmentStep | undefined {
    return this.steps.get(id);
  }

  all(): ReadonlyMap<EnrichmentStepId, EnrichmentStep> {
    return this.steps;
  }
}

/** A retention task run with the nightly refresh (e.g. purging expired review insights, BF-029). */
export type NightlyMaintenanceTask = (now: Date) => Promise<number>;

/**
 * Retention hooks of other modules, run once per night before the refresh (Registry, like the steps). A failing hook
 * is logged and does not stop the others or the refresh.
 */
@Injectable()
export class NightlyMaintenance {
  private readonly tasks = new Map<string, NightlyMaintenanceTask>();

  register(name: string, task: NightlyMaintenanceTask): void {
    if (this.tasks.has(name)) throw new Error(`Nightly maintenance task ${name} is already registered`);
    this.tasks.set(name, task);
  }

  all(): ReadonlyMap<string, NightlyMaintenanceTask> {
    return this.tasks;
  }
}
