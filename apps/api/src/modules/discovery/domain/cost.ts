import type { ProviderCostModel, ProviderSku } from '@bf/contracts';

// Provider cost arithmetic (BF-018): per-SKU prices with free monthly allowances per billing account.

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function skuOf(model: ProviderCostModel, sku: string): ProviderSku | undefined {
  return model.skus.find((s) => s.sku === sku);
}

/**
 * Cost of `calls` more calls on a SKU when the billing account already made `usedThisMonth` this month: calls
 * within the free allowance cost nothing (when `applyFreeTier`), the rest are charged at the first-tier price.
 */
export function callCost(
  sku: Pick<ProviderSku, 'perThousandUsd' | 'freeMonthlyCalls'>,
  usedThisMonth: number,
  calls: number,
  applyFreeTier: boolean,
): number {
  if (calls <= 0) return 0;
  const free = applyFreeTier ? sku.freeMonthlyCalls : 0;
  const billable = Math.max(0, usedThisMonth + calls - free) - Math.max(0, usedThisMonth - free);
  return round6((billable * sku.perThousandUsd) / 1000);
}

export interface CostLine {
  readonly sku: string;
  readonly calls: number;
  readonly costUsd: number;
}

export interface CostEstimate {
  readonly lines: readonly CostLine[];
  readonly totalUsd: number;
}

/** Estimate for planned calls per SKU, given this month's usage per SKU (unknown SKUs are priced at 0). */
export function estimateCost(
  model: ProviderCostModel,
  planned: ReadonlyArray<{ readonly sku: string; readonly calls: number }>,
  usedThisMonth: ReadonlyMap<string, number>,
  applyFreeTier: boolean,
): CostEstimate {
  const bySku = new Map<string, number>();
  for (const { sku, calls } of planned) bySku.set(sku, (bySku.get(sku) ?? 0) + calls);
  const lines = [...bySku].map(([sku, calls]) => {
    const price = skuOf(model, sku);
    return {
      sku,
      calls,
      costUsd: price ? callCost(price, usedThisMonth.get(sku) ?? 0, calls, applyFreeTier) : 0,
    };
  });
  return { lines, totalUsd: round6(lines.reduce((sum, line) => sum + line.costUsd, 0)) };
}
