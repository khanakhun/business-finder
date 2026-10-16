import type { ProviderId, ProviderUsageRow } from '@bf/contracts';
import { type DbClient, getExecutor, runInTransaction } from '@bf/db';
import { providerUsage } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, between, eq, gte, lt, sql } from 'drizzle-orm';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { ProviderUsageMeter, UsageEvent } from '../application/ports.ts';
import { callCost } from '../domain/cost.ts';

const dayOf = (at: Date) => at.toISOString().slice(0, 10);
const monthRange = (at: Date) => {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start: dayOf(start), end: dayOf(end) };
};

@Injectable()
export class DrizzleProviderUsageMeter implements ProviderUsageMeter {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async record(
    event: UsageEvent,
    price: { perThousandUsd: number; freeMonthlyCalls: number } | null,
  ): Promise<number> {
    // Serialized per account, provider, SKU and month: concurrent calls must not both use the last free calls.
    return runInTransaction(this.db, async (tx) => {
      const lock = `usage:${event.billingScope}:${event.provider}:${event.sku}:${monthRange(event.at).start}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lock}))`);
      const used = price
        ? ((await this.monthCalls(event.billingScope, event.provider, event.at)).get(event.sku) ?? 0)
        : 0;
      const cost = price ? callCost(price, used, event.calls, this.env.DISCOVERY_APPLY_FREE_TIER) : 0;
      await this.write(event, cost);
      return cost;
    });
  }

  private async write(event: UsageEvent, cost: number): Promise<void> {
    await getExecutor(this.db)
      .insert(providerUsage)
      .values({
        organizationId: event.organizationId,
        provider: event.provider,
        sku: event.sku,
        day: dayOf(event.at),
        billingScope: event.billingScope,
        calls: event.calls,
        results: event.results,
        costUsd: cost,
      })
      .onConflictDoUpdate({
        target: [
          providerUsage.organizationId,
          providerUsage.provider,
          providerUsage.sku,
          providerUsage.day,
          providerUsage.billingScope,
        ],
        set: {
          calls: sql`${providerUsage.calls} + excluded.calls`,
          results: sql`${providerUsage.results} + excluded.results`,
          costUsd: sql`${providerUsage.costUsd} + excluded.cost_usd`,
          updatedAt: sql`now()`,
        },
      });
  }

  async monthCalls(billingScope: string, provider: ProviderId, at: Date): Promise<Map<string, number>> {
    const { start, end } = monthRange(at);
    const rows = await getExecutor(this.db)
      .select({ sku: providerUsage.sku, calls: sql<number>`sum(${providerUsage.calls})::int` })
      .from(providerUsage)
      .where(
        and(
          eq(providerUsage.billingScope, billingScope),
          eq(providerUsage.provider, provider),
          gte(providerUsage.day, start),
          lt(providerUsage.day, end),
        ),
      )
      .groupBy(providerUsage.sku);
    return new Map(rows.map((r) => [r.sku, Number(r.calls)]));
  }

  async monthCostUsd(organizationId: string, at: Date): Promise<number> {
    const { start, end } = monthRange(at);
    const [row] = await getExecutor(this.db)
      .select({ cost: sql<string>`coalesce(sum(${providerUsage.costUsd}), 0)` })
      .from(providerUsage)
      .where(
        and(
          eq(providerUsage.organizationId, organizationId),
          gte(providerUsage.day, start),
          lt(providerUsage.day, end),
        ),
      );
    return Number(row?.cost ?? 0);
  }

  async report(organizationId: string, from: string, to: string): Promise<ProviderUsageRow[]> {
    const rows = await getExecutor(this.db)
      .select({
        day: providerUsage.day,
        provider: providerUsage.provider,
        sku: providerUsage.sku,
        calls: sql<number>`sum(${providerUsage.calls})::int`,
        results: sql<number>`sum(${providerUsage.results})::int`,
        costUsd: sql<string>`sum(${providerUsage.costUsd})`,
      })
      .from(providerUsage)
      .where(and(eq(providerUsage.organizationId, organizationId), between(providerUsage.day, from, to)))
      .groupBy(providerUsage.day, providerUsage.provider, providerUsage.sku)
      .orderBy(asc(providerUsage.day), asc(providerUsage.provider), asc(providerUsage.sku));
    return rows.map((r) => ({
      day: r.day,
      provider: r.provider,
      sku: r.sku,
      calls: Number(r.calls),
      results: Number(r.results),
      costUsd: Number(r.costUsd),
    }));
  }
}
