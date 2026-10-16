import { z } from 'zod';
import { defineEvent } from './events.ts';
import { IsoDateTimeSchema } from './time.ts';

// AI usage (BF-013): ledger aggregates for `GET /v1/ai/usage`, and the soft-budget event.

export const AiUsageQuerySchema = z
  .object({
    from: IsoDateTimeSchema.optional().describe(
      'Start (inclusive); default: start of the current month (UTC).',
    ),
    to: IsoDateTimeSchema.optional().describe('End (exclusive); default: now.'),
  })
  .meta({ id: 'AiUsageQuery' });
export type AiUsageQuery = z.infer<typeof AiUsageQuerySchema>;

const UsageTotalsSchema = z.object({
  calls: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z
    .number()
    .nonnegative()
    .describe('Priced calls only (models without a configured price count 0).'),
});

export const AiUsageSchema = z
  .object({
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
    totals: UsageTotalsSchema,
    byTask: z.array(UsageTotalsSchema.extend({ task: z.string() })),
    byModel: z.array(UsageTotalsSchema.extend({ provider: z.string(), model: z.string() })),
    byDay: z.array(UsageTotalsSchema.extend({ day: z.string().describe('YYYY-MM-DD (UTC).') })),
    budget: z.object({ softUsd: z.number(), hardUsd: z.number(), monthToDateUsd: z.number() }),
  })
  .meta({ id: 'AiUsage' });
export type AiUsage = z.infer<typeof AiUsageSchema>;

/** A workspace passed its monthly soft AI budget (once per month). */
export const AiBudgetSoftLimitReached = defineEvent(
  'ai.budget_soft_limit_reached',
  1,
  z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), spentUsd: z.number(), softLimitUsd: z.number() }),
);
