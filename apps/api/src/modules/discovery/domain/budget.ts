// Run budgets (BF-020): a call is made only after reserving its maximum cost, so `cost + reserved` never exceeds
// the budget; after the call the reservation is released and the actual cost (≤ the reservation) recorded.

const EPSILON = 1e-9;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export interface BudgetState {
  readonly budgetUsd: number;
  readonly costUsd: number;
  readonly reservedUsd: number;
}

/** Whether `amount` more can be reserved without ever exceeding the budget. */
export function canReserve(state: BudgetState, amount: number): boolean {
  return state.costUsd + state.reservedUsd + amount <= state.budgetUsd + EPSILON;
}

/** The state after a call reserved `reserved` and actually cost `actual` (never more than reserved). */
export function settle(state: BudgetState, reserved: number, actual: number): BudgetState {
  return {
    budgetUsd: state.budgetUsd,
    costUsd: round6(state.costUsd + Math.min(actual, reserved)),
    reservedUsd: round6(Math.max(0, state.reservedUsd - reserved)),
  };
}
