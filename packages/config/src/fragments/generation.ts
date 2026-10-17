import { z } from 'zod';
import { booleanFlag } from '../schema.ts';

/** Site generation (BF-039): engines, the sandbox pool and the fake engine for development and tests. */
export const generationEnv = z.object({
  GENERATION_BLOCKS_ENGINE: booleanFlag(true).describe(
    'Register the blocks engine (BF-041), the default: sites composed in-process by the AI gateway (needs model keys).',
  ),
  GENERATION_CLAUDE_CODE_ENGINE: booleanFlag(false).describe(
    'Register the Claude Code engine (BF-044): `claude -p` in a sandbox; needs SANDBOX_ENABLED and an Anthropic key per workspace.',
  ),
  GENERATION_CLAUDE_CODE_SITEKIT: z
    .enum(['bash', 'mcp'])
    .default('bash')
    .describe(
      'How Claude Code reaches sitekit: `Bash(sitekit *)` only (bash) or the `sitekit mcp` server with no shell (mcp).',
    ),
  GENERATION_CLAUDE_AGENT_SDK_ENGINE: booleanFlag(false).describe(
    'Register the Claude Agent SDK engine (BF-044): `query()` in a sandbox, sitekit over MCP, no shell; needs SANDBOX_ENABLED and an Anthropic key per workspace.',
  ),
  GENERATION_CODEX_ENGINE: booleanFlag(false).describe(
    'Register the Codex engine (BF-044): `codex exec` in a sandbox; needs SANDBOX_ENABLED and an OpenAI key per workspace.',
  ),
  GENERATION_CODEX_MODEL: z
    .string()
    .min(1)
    .default('gpt-6.1-sol')
    .describe(
      "Codex's model (OpenAI's recommendation for agentic coding, October 2026); price it in AI_PRICING.",
    ),
  GENERATION_CODEX_REASONING_EFFORT: z
    .enum(['low', 'medium', 'high', 'xhigh'])
    .default('high')
    .describe("Codex's reasoning effort (`model_reasoning_effort`)."),
  GENERATION_AGENT_WALL_TIME_SEC: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(900)
    .describe('Wall time of one coding-agent run in its sandbox (BF-044).'),
  GENERATION_AGENT_MAX_TURNS: z.coerce
    .number()
    .int()
    .min(5)
    .max(300)
    .default(60)
    .describe('Turns a coding agent may take in one run (BF-044).'),
  GENERATION_AGENT_BUDGET_MARGIN: z.coerce
    .number()
    .min(0)
    .max(0.5)
    .default(0.15)
    .describe(
      "Share of an attempt's budget kept back from the agent's own limit (it can overshoot by a turn).",
    ),
  GENERATION_QUALITY_AUDITS: booleanFlag(false).describe(
    'Run the render-based quality gates (BF-045: axe-core accessibility, Lighthouse) in a no-network sandbox; needs SANDBOX_ENABLED. On in production.',
  ),
  GENERATION_QUALITY_AUDIT_WALL_TIME_SEC: z.coerce
    .number()
    .int()
    .min(30)
    .max(900)
    .default(180)
    .describe(
      'Wall time of one sandboxed quality audit (BF-045; the target is under 90 s for 4 pages × 2 locales).',
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
  SANDBOX_ENABLED: booleanFlag(false).describe(
    'Sandboxed engines run on this deployment (BF-043): the worker checks the runner image at start (readiness) and the janitor removes stale sandboxes.',
  ),
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
