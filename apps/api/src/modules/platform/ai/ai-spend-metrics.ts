import type { ApiEnv } from '@bf/config';
import { type DbClient, getExecutor } from '@bf/db';
import { metrics } from '@bf/observability';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_ENV, type AppEnv } from '../config/app-env.ts';
import { DB_CLIENT } from '../db/db.module.ts';
import { LOGGER, type Logger } from '../logging/logger.ts';

// AI spend against the monthly budget (BF-061): every 5 minutes, this calendar month's spend per workspace from the
// llm_calls ledger, and the budget limits, for the "spend > 80% of the budget" alert and the LLM dashboard. Worker
// only. Cost per call and per feature stays in Langfuse and the analytics pages.

const SAMPLE_MS = 5 * 60_000;

const spend = () =>
  metrics.gauge({
    name: 'bf_ai_spend_month_usd',
    help: "This calendar month's AI spend per workspace (llm_calls ledger)",
    labelNames: ['organization'],
  });
const budget = () =>
  metrics.gauge({
    name: 'bf_ai_budget_month_usd',
    help: 'Monthly AI budget per workspace, by level (soft: notify, hard: refuse)',
    labelNames: ['level'],
  });

@Injectable()
export class AiSpendSampler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    const env = this.env as ApiEnv;
    budget().set({ level: 'soft' }, env.AI_BUDGET_MONTHLY_SOFT_USD);
    budget().set({ level: 'hard' }, env.AI_BUDGET_MONTHLY_HARD_USD);
    this.timer = setInterval(() => void this.sample(), SAMPLE_MS);
    this.timer.unref();
    void this.sample();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sample(): Promise<void> {
    try {
      const rows = await getExecutor(this.db).execute<{ organization_id: string; usd: number }>(sql`
        SELECT organization_id::text, coalesce(sum(cost_usd), 0)::float8 AS usd
        FROM llm_calls
        WHERE organization_id IS NOT NULL AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
        GROUP BY organization_id`);
      spend().reset();
      for (const row of rows) spend().set({ organization: row.organization_id }, Number(row.usd));
    } catch (error) {
      this.logger.warn({ err: error }, 'AI spend sample failed');
    }
  }
}
