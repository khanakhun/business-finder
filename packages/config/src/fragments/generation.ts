import { z } from 'zod';
import { booleanFlag } from '../schema.ts';

/** Site generation (BF-039): engines, the sandbox pool and the fake engine for development and tests. */
export const generationEnv = z.object({
  GENERATION_BLOCKS_ENGINE: booleanFlag(false).describe(
    'Register the blocks engine (BF-041): sites composed in-process by the AI gateway (needs model keys).',
  ),
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
  SANDBOX_DOCKER_HOST: z
    .string()
    .regex(/^(unix:\/\/\/|tcp:\/\/|https?:\/\/)\S+$/)
    .default('unix:///var/run/docker.sock')
    .describe(
      'Docker Engine API the worker starts sandboxes through (BF-043): the socket proxy in production (tcp://docker-socket-proxy:2375), never the raw socket.',
    ),
  SANDBOX_RUNNER_IMAGE: z
    .string()
    .min(1)
    .default('bf-agent-runner:dev')
    .describe('The agent runner image, pinned by digest in production (ghcr.io/…/bf-agent-runner@sha256:…).'),
  SANDBOX_NETWORK: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{1,64}$/)
    .default('none')
    .describe('The internal sandbox network (`bf-sandbox`); `none` runs sandboxes without any network.'),
  SANDBOX_EGRESS_PROXY_URL: z
    .url()
    .optional()
    .describe(
      'The egress allowlist proxy sandboxes reach model APIs through (e.g. http://egress-proxy:4750).',
    ),
  SANDBOX_CPUS: z.coerce.number().positive().max(16).default(2).describe('CPUs per sandbox.'),
  SANDBOX_MEMORY_MB: z.coerce
    .number()
    .int()
    .min(512)
    .max(32_768)
    .default(4096)
    .describe('Memory per sandbox (no swap).'),
  SANDBOX_PIDS_LIMIT: z.coerce
    .number()
    .int()
    .min(64)
    .max(4096)
    .default(512)
    .describe('Processes per sandbox.'),
});
