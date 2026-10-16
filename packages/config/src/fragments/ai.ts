import { z } from 'zod';
import { secret } from '../schema.ts';

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
});
