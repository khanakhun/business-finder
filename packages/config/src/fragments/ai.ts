import { z } from 'zod';
import { booleanFlag, secret } from '../schema.ts';

/** A JSON object env var, validated with `shape`. */
const jsonObject = <T extends z.ZodType>(shape: T, example: string) =>
  z
    .string()
    .optional()
    .transform((value, ctx): z.output<T> => {
      if (value === undefined || value.trim() === '') return shape.parse({});
      try {
        return shape.parse(JSON.parse(value));
      } catch {
        ctx.addIssue({ code: 'custom', message: `Expected JSON like ${example}` });
        return z.NEVER;
      }
    });

const usd = (fallback: number) => z.coerce.number().nonnegative().default(fallback);

export const aiEnv = z.object({
  ANTHROPIC_API_KEY: secret(
    z.string().min(1).optional().describe('Anthropic API key (LLM gateway, agents).'),
  ),
  OPENAI_API_KEY: secret(
    z.string().min(1).optional().describe('OpenAI API key (LLM gateway, Codex engine).'),
  ),
  AI_MODEL_OVERRIDES: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return {};
      try {
        return z.record(z.string(), z.string().min(1)).parse(JSON.parse(value));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Expected a JSON object of task → model id' });
        return z.NEVER;
      }
    })
    .describe('JSON map overriding the prompt registry model per task, e.g. {"classify":"<model-id>"}.'),
  // Routing table (ADR-0011): model ids live in configuration only. `provider:id` or bare ids (claude-*, gpt-*).
  AI_MODEL_FAST: z.string().min(1).default('claude-haiku-5-5').describe('Model for `fast` tasks.'),
  AI_MODEL_SMART: z.string().min(1).default('claude-sonnet-5-5').describe('Model for `smart` tasks.'),
  AI_MODEL_AGENT: z.string().min(1).default('claude-opus-5-5').describe('Model for `agent` tasks.'),
  AI_MODEL_FALLBACKS: jsonObject(
    z.record(z.string(), z.array(z.string().min(1))),
    '{"claude-haiku-5-5":["openai:<model-id>"]}',
  ).describe('JSON map: model id or tier → models tried when it is unavailable, in order.'),
  AI_EMBEDDING_MODEL: z
    .string()
    .min(1)
    .default('openai:text-embedding-3-small')
    .describe('Embedding model (1536 dimensions by default).'),
  AI_PRICING: jsonObject(
    z.record(
      z.string(),
      z.object({
        inputPerMTok: z.number().nonnegative(),
        outputPerMTok: z.number().nonnegative(),
        cachedInputPerMTok: z.number().nonnegative().optional(),
      }),
    ),
    '{"<model-id>":{"inputPerMTok":1,"outputPerMTok":5}}',
  ).describe('JSON map: model id → USD per million input/output/cached tokens. Unpriced models cost null.'),
  AI_IMAGE_MODEL: z
    .string()
    .min(1)
    .default('gpt-image-2')
    .describe('OpenAI image model for illustrative AI images (BF-038). Verify the current ID and price.'),
  AI_IMAGE_PRICE_USD: z.coerce
    .number()
    .nonnegative()
    .default(0.06)
    .describe('Cost recorded per generated image (medium quality, 1536 px): budgets count it.'),
  AI_IMAGES_DAILY_CAP: z.coerce
    .number()
    .int()
    .min(0)
    .default(24)
    .describe('AI images a workspace may generate per day (0 turns AI images off).'),
  AI_BUDGET_MONTHLY_SOFT_USD: usd(25).describe('Per-workspace monthly AI spend that triggers a warning.'),
  AI_BUDGET_MONTHLY_HARD_USD: usd(100).describe(
    'Per-workspace monthly AI spend above which non-essential tasks stop.',
  ),
  AI_TRACE_CONTENT: booleanFlag(false).describe(
    'Send prompt and response bodies to tracing/Langfuse (emails and phones masked). Keep off in production.',
  ),
  LANGFUSE_PUBLIC_KEY: z
    .string()
    .min(1)
    .optional()
    .describe('Langfuse public key; tracing to Langfuse is off when unset.'),
  LANGFUSE_SECRET_KEY: secret(z.string().min(1).optional().describe('Langfuse secret key.')),
  LANGFUSE_BASE_URL: z
    .url()
    .default('https://cloud.langfuse.com')
    .describe('Langfuse host (cloud region or self-hosted).'),
});
