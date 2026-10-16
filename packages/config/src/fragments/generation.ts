import { z } from 'zod';
import { booleanFlag } from '../schema.ts';

/** Site generation (BF-039): engines, the sandbox pool and the fake engine for development and tests. */
export const generationEnv = z.object({
  GENERATION_FAKE_ENGINE: booleanFlag(false).describe(
    'Register the scripted fake engine (development, tests and E2E only; refused in production).',
  ),
  GENERATION_MAX_SANDBOXES: z.coerce
    .number()
    .int()
    .min(0)
    .max(64)
    .default(4)
    .describe('Sandboxed engine runs at once across the deployment (Claude Code, Codex, …).'),
  GENERATION_FAKE_DURATION_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(600_000)
    .default(1_500)
    .describe("The fake engine's run time (tests set it short, load tests realistic)."),
});
