import type { ApiEnv } from '@bf/config';
import { type AiUsage, AiUsageQuerySchema, AiUsageSchema, type Clock } from '@bf/contracts';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CLOCK } from '../clock/clock.module.ts';
import { APP_ENV, type AppEnv } from '../config/app-env.ts';
import { Ctx, RequirePermission } from '../security/auth.decorators.ts';
import type { AuthContext } from '../security/auth-context.ts';
import { ApiRoute } from '../validation/api-route.decorator.ts';
import { zodDto } from '../validation/zod-dto.ts';
import { monthStart } from './ai-adapters.ts';
import { LlmCallRepository, type UsageTotals } from './llm-call.repository.ts';

class AiUsageQueryDto extends zodDto(AiUsageQuerySchema) {}

const totals = (row: UsageTotals | undefined): UsageTotals => ({
  calls: row?.calls ?? 0,
  errors: row?.errors ?? 0,
  inputTokens: row?.inputTokens ?? 0,
  outputTokens: row?.outputTokens ?? 0,
  costUsd: Math.round((row?.costUsd ?? 0) * 1_000_000) / 1_000_000,
});

/** AI spend of the active workspace (owners and admins); the dashboard UI comes with BF-058. */
@ApiTags('ai')
@Controller('ai')
export class AiUsageController {
  constructor(
    private readonly ledger: LlmCallRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  @Get('usage')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'AI usage and cost of the active workspace by task, model and day',
    operationId: 'getAiUsage',
    query: AiUsageQueryDto,
    response: { status: 200, schema: AiUsageSchema },
    errors: [401, 403],
  })
  async usage(@Ctx() auth: AuthContext, @Query() query: AiUsageQueryDto): Promise<AiUsage> {
    const orgId = auth.orgId as string;
    const now = this.clock.now();
    const from = query.from ? new Date(query.from) : monthStart(now);
    const to = query.to ? new Date(query.to) : now;
    const [all, byTask, byModel, byDay, monthToDate] = await Promise.all([
      this.ledger.aggregate(orgId, from, to, 'none'),
      this.ledger.aggregate(orgId, from, to, 'task'),
      this.ledger.aggregate(orgId, from, to, 'model'),
      this.ledger.aggregate(orgId, from, to, 'day'),
      this.ledger.spentSince(orgId, monthStart(now)),
    ]);
    const env = this.env as ApiEnv;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: totals(all[0]),
      byTask: byTask.map((row) => ({ task: String(row.task), ...totals(row) })),
      byModel: byModel.map((row) => ({
        provider: String(row.provider),
        model: String(row.model),
        ...totals(row),
      })),
      byDay: byDay.map((row) => ({ day: String(row.day), ...totals(row) })),
      budget: {
        softUsd: env.AI_BUDGET_MONTHLY_SOFT_USD,
        hardUsd: env.AI_BUDGET_MONTHLY_HARD_USD,
        monthToDateUsd: Math.round(monthToDate * 1_000_000) / 1_000_000,
      },
    };
  }
}
