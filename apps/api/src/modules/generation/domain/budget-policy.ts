import type { EngineId } from '@bf/contracts';

// Budgets (BF-039): a job's budget is its own or the engine's default, never above the workspace cap; a batch's
// budget bounds the sum of its jobs; the workspace's monthly AI budget (BF-013) blocks new work when spent.

export const MAX_JOB_BUDGET_USD = 50;

export function jobBudget(requested: number | undefined, engineDefault: number | undefined): number {
  return Math.min(requested ?? engineDefault ?? 2, MAX_JOB_BUDGET_USD);
}

/** Whether a job may start: the workspace's month and the batch's spend leave room for it. */
export function canStart(input: {
  readonly workspace: 'ok' | 'soft' | 'hard';
  readonly batchBudgetUsd: number | null;
  readonly batchCostUsd: number;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'BUDGET_EXCEEDED'; readonly reason: string } {
  if (input.workspace === 'hard')
    return { ok: false, code: 'BUDGET_EXCEEDED', reason: 'the workspace’s monthly AI budget is spent' };
  if (input.batchBudgetUsd !== null && input.batchCostUsd >= input.batchBudgetUsd)
    return { ok: false, code: 'BUDGET_EXCEEDED', reason: 'the batch budget is spent' };
  return { ok: true };
}

/** Whether a running attempt went over its job's budget. */
export const overBudget = (costUsd: number, budgetUsd: number) => costUsd > budgetUsd;

/** The cheapest engine of the chain whose typical cost fits what is left (a cheaper fallback near the budget). */
export function cheaperEngine(
  chain: readonly { readonly id: EngineId; readonly typicalCostUsd: number }[],
  leftUsd: number,
): EngineId | undefined {
  return [...chain]
    .filter((engine) => engine.typicalCostUsd <= leftUsd)
    .sort((a, b) => a.typicalCostUsd - b.typicalCostUsd)[0]?.id;
}
