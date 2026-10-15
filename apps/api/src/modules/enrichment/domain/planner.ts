import {
  ENRICHMENT_STEP_IDS,
  type EnrichmentSkipReason,
  type EnrichmentStepId,
  ValidationError,
} from '@bf/contracts';
import type { EnrichmentStep, EnrichmentSubject, StepOutput } from './enrichment-step.ts';

// Planning a run (BF-027): requested steps + their dependencies → a DAG of steps to run or skip, in dependency
// order, with estimates. Pure: everything it needs is passed in.

const DAY_MS = 24 * 3_600_000;

/** Whether `last` still stands for `inputHash` at `now` (same input, within the TTL or the step's own rule). */
export function isFresh(
  step: Pick<EnrichmentStep, 'ttlDays' | 'isStale'>,
  last: StepOutput | undefined,
  inputHash: string,
  now: Date,
): boolean {
  if (!last || last.inputHash !== inputHash) return false;
  if (step.isStale) return !step.isStale(last, now);
  return now.getTime() - last.finishedAt.getTime() < step.ttlDays * DAY_MS;
}

export interface PlannedStep {
  readonly step: EnrichmentStepId;
  readonly dependsOn: readonly EnrichmentStepId[];
  readonly status: 'queued' | 'skipped';
  readonly skipReason: EnrichmentSkipReason | null;
  readonly inputHash: string | null;
  readonly estimatedUsd: number;
}

export interface PlanInput {
  /** Default: every registered step. */
  readonly requested?: readonly EnrichmentStepId[];
  readonly steps: ReadonlyMap<EnrichmentStepId, EnrichmentStep>;
  readonly subject: EnrichmentSubject;
  /** Latest finished output per step for this business. */
  readonly last: ReadonlyMap<EnrichmentStepId, StepOutput>;
  readonly force: boolean;
  readonly now: Date;
  /** What is left of the workspace's monthly budget; null for no cap. */
  readonly remainingUsd: number | null;
}

export interface Plan {
  readonly steps: readonly PlannedStep[];
  readonly estimatedUsd: number;
}

/** Requested steps and, transitively, what they depend on — in dependency order (ties: catalogue order). */
export function resolveOrder(
  requested: readonly EnrichmentStepId[],
  steps: ReadonlyMap<EnrichmentStepId, EnrichmentStep>,
): EnrichmentStepId[] {
  const order: EnrichmentStepId[] = [];
  const state = new Map<EnrichmentStepId, 'visiting' | 'done'>();
  const visit = (id: EnrichmentStepId, path: readonly EnrichmentStepId[]) => {
    const seen = state.get(id);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      throw new ValidationError(
        `Enrichment steps depend on each other in a cycle: ${[...path, id].join(' → ')}`,
      );
    }
    state.set(id, 'visiting');
    const dependencies = [...(steps.get(id)?.dependsOn ?? [])].sort(byCatalogue);
    for (const dependency of dependencies) visit(dependency, [...path, id]);
    state.set(id, 'done');
    order.push(id);
  };
  for (const id of [...requested].sort(byCatalogue)) visit(id, []);
  return order;
}

const byCatalogue = (a: EnrichmentStepId, b: EnrichmentStepId) =>
  ENRICHMENT_STEP_IDS.indexOf(a) - ENRICHMENT_STEP_IDS.indexOf(b);

/**
 * Each step in dependency order is skipped when it is not registered, does not apply, depends on a step that will
 * not produce an output, is fresh (unless `force`), or would take the workspace over its monthly budget; it is
 * queued otherwise. A dependency skipped as `fresh` still provides its (earlier) output.
 */
export function planRun(input: PlanInput): Plan {
  const requested = input.requested ?? [...input.steps.keys()];
  const planned = new Map<EnrichmentStepId, PlannedStep>();
  let estimatedUsd = 0;
  for (const id of resolveOrder(requested, input.steps)) {
    const step = input.steps.get(id);
    const dependsOn = step ? [...step.dependsOn] : [];
    const skip = (reason: EnrichmentSkipReason, inputHash: string | null = null): PlannedStep => ({
      step: id,
      dependsOn,
      status: 'skipped',
      skipReason: reason,
      inputHash,
      estimatedUsd: 0,
    });
    if (!step) {
      planned.set(id, skip('not_registered'));
      continue;
    }
    const optional = new Set(step.optionalDependencies ?? []);
    const blocked = dependsOn
      .filter((dependency) => !optional.has(dependency))
      .map((dependency) => planned.get(dependency))
      .find((dependency) => dependency?.status === 'skipped' && dependency.skipReason !== 'fresh');
    if (blocked) {
      planned.set(id, skip('dependency_skipped'));
      continue;
    }
    const applies = step.appliesTo(input.subject);
    if (applies !== true) {
      planned.set(id, skip(applies));
      continue;
    }
    const inputHash = step.inputHash(input.subject);
    // A dependency that runs again may change this step's input: it is not "fresh" then.
    const dependencyRuns = dependsOn.some((dependency) => planned.get(dependency)?.status === 'queued');
    if (!input.force && !dependencyRuns && isFresh(step, input.last.get(id), inputHash, input.now)) {
      planned.set(id, skip('fresh', inputHash));
      continue;
    }
    const cost = Math.max(0, step.estimateCost(input.subject));
    if (input.remainingUsd !== null && cost > 0 && estimatedUsd + cost > input.remainingUsd) {
      planned.set(id, skip('budget', inputHash));
      continue;
    }
    estimatedUsd += cost;
    planned.set(id, {
      step: id,
      dependsOn,
      status: 'queued',
      skipReason: null,
      inputHash,
      estimatedUsd: cost,
    });
  }
  return { steps: [...planned.values()], estimatedUsd };
}
