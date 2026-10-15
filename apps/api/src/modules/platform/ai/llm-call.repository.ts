import type { LlmCall, LlmCallRecorder } from '@bf/ai';
import type { DbClient } from '@bf/db';
import { llmCalls } from '@bf/db/schema';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gte, lt, sql, sum } from 'drizzle-orm';
import { DB_CLIENT } from '../db/db.module.ts';
import { LOGGER } from '../logging/logger.ts';

export interface UsageTotals {
  readonly calls: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/** The `llm_calls` ledger: written for every gateway call, read for budgets and usage reports. */
@Injectable()
export class LlmCallRepository implements LlmCallRecorder {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Never throws: a lost ledger row must not fail the model call (it is logged instead). */
  async record(call: LlmCall): Promise<void> {
    try {
      // Root client on purpose: the ledger row stays even if the caller's transaction rolls back.
      await this.db.insert(llmCalls).values({
        organizationId: call.orgId,
        task: call.task,
        promptVersion: call.promptVersion,
        provider: call.provider,
        model: call.model,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        cachedTokens: call.cachedTokens,
        costUsd: call.costUsd,
        latencyMs: call.latencyMs,
        status: call.status,
        errorCode: call.errorCode,
        traceId: call.traceId,
      });
    } catch (error) {
      this.logger.warn({ err: error, task: call.task }, 'could not record LLM call');
    }
  }

  async spentSince(organizationId: string, from: Date): Promise<number> {
    const [row] = await this.db
      .select({ total: sum(llmCalls.costUsd) })
      .from(llmCalls)
      .where(and(eq(llmCalls.organizationId, organizationId), gte(llmCalls.createdAt, from)));
    return Number(row?.total ?? 0);
  }

  /** Aggregates for one workspace over [from, to), grouped by `key` (none = totals). */
  async aggregate(
    organizationId: string,
    from: Date,
    to: Date,
    groupBy: 'none' | 'task' | 'model' | 'day',
  ): Promise<Array<UsageTotals & Record<string, string | number>>> {
    const keys = {
      none: {},
      task: { task: llmCalls.task },
      model: { provider: llmCalls.provider, model: llmCalls.model },
      day: { day: sql<string>`to_char(${llmCalls.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')` },
    }[groupBy];
    const rows = await this.db
      .select({
        ...keys,
        calls: count(),
        errors: sql<number>`count(*) FILTER (WHERE ${llmCalls.status} = 'error')`.mapWith(Number),
        inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)`.mapWith(Number),
        outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)`.mapWith(Number),
        costUsd: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)`.mapWith(Number),
      })
      .from(llmCalls)
      .where(
        and(
          eq(llmCalls.organizationId, organizationId),
          gte(llmCalls.createdAt, from),
          lt(llmCalls.createdAt, to),
        ),
      )
      .groupBy(...Object.values(keys))
      .orderBy(...Object.values(keys));
    return rows as Array<UsageTotals & Record<string, string | number>>;
  }
}
