// pnpm generation:bench [--engines blocks,claude-code,codex,claude-agent-sdk] [--limit 8] [--only id,id]
// The engines' benchmark (BF-044): every engine on the same synthetic businesses (apps/api/evals/blocks-engine,
// fake data), each result measured the same way (validity with strict facts, fact violations, copy lint), with cost,
// duration and tool calls. Real models and real sandboxes: needs ANTHROPIC_API_KEY / OPENAI_API_KEY, Docker and the
// runner image (SANDBOX_RUNNER_IMAGE); costs money. Writes apps/api/evals/bench/reports/<timestamp>.{md,json}.
// DECISION(BF-044): the engines run directly (one attempt each, no orchestrator, no repair), so the numbers compare
// engines, not retries; the quality score joins when BF-045's gates exist.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { type AiGateway, createAiGateway } from '@bf/ai';
import { aiEnv, generationEnv, loadEnvOrExit } from '@bf/config';
import { type EngineEvent, type EngineId, EngineIdSchema } from '@bf/contracts';
import type { AgentEngine, EngineRunContext } from '../modules/generation/application/ports.ts';
import { BlocksEngine } from '../modules/generation/infrastructure/engines/blocks/blocks.engine.ts';
import {
  DATASET,
  evalWorkspace,
  loadBusinesses,
  measure,
} from '../modules/generation/infrastructure/engines/blocks/eval/harness.ts';
import { ClaudeAgentSdkEngine } from '../modules/generation/infrastructure/engines/claude-agent-sdk/claude-agent-sdk.engine.ts';
import { ClaudeCodeEngine } from '../modules/generation/infrastructure/engines/claude-code/claude-code.engine.ts';
import { CodexEngine } from '../modules/generation/infrastructure/engines/codex/codex.engine.ts';
import type { SandboxedEngineDeps } from '../modules/generation/infrastructure/engines/sandboxed/sandboxed-agent.engine.ts';
import { HttpDockerApi } from '../modules/generation/infrastructure/sandbox/docker-engine.ts';
import { DockerSandboxProvider } from '../modules/generation/infrastructure/sandbox/docker-sandbox.ts';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    engines: { type: 'string', default: 'blocks,claude-code,codex,claude-agent-sdk' },
    limit: { type: 'string', default: '8' },
    only: { type: 'string' },
    budget: { type: 'string', default: '4' },
  },
});

const env = loadEnvOrExit(aiEnv.extend(generationEnv.shape), { label: 'generation:bench' });
const engineIds = (values.engines ?? '').split(',').map((id) => EngineIdSchema.parse(id.trim()));
const gateway: AiGateway = createAiGateway({
  routing: {
    tiers: { fast: env.AI_MODEL_FAST, smart: env.AI_MODEL_SMART, agent: env.AI_MODEL_AGENT },
    overrides: env.AI_MODEL_OVERRIDES,
    fallbacks: env.AI_MODEL_FALLBACKS,
    embeddingModel: env.AI_EMBEDDING_MODEL,
  },
  keys: {
    resolve: async (_org, provider) =>
      provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY,
  },
  pricing: env.AI_PRICING,
});

const sandboxed = (key: string | undefined, model: string): SandboxedEngineDeps => ({
  sandbox: new DockerSandboxProvider(new HttpDockerApi(env.SANDBOX_DOCKER_HOST), {
    network: env.SANDBOX_NETWORK,
    ...(env.SANDBOX_EGRESS_PROXY_URL ? { egressProxyUrl: env.SANDBOX_EGRESS_PROXY_URL } : {}),
  }),
  artifacts: { get: async () => undefined, put: async () => undefined },
  keys: { resolve: async () => key },
  settings: {
    enabled: true,
    image: env.SANDBOX_RUNNER_IMAGE,
    cpus: env.SANDBOX_CPUS,
    memoryMb: env.SANDBOX_MEMORY_MB,
    pidsLimit: env.SANDBOX_PIDS_LIMIT,
    wallTimeSec: env.GENERATION_AGENT_WALL_TIME_SEC,
    maxTurns: env.GENERATION_AGENT_MAX_TURNS,
    budgetMargin: env.GENERATION_AGENT_BUDGET_MARGIN,
    model,
  },
});

/** The engine, reading the bundle from `bundle` (each run gets its own). */
function engine(id: EngineId, bundle: Uint8Array): AgentEngine {
  const withBundle = <T extends SandboxedEngineDeps>(deps: T): T => ({
    ...deps,
    artifacts: {
      get: async (key: string) => (key === 'bundle' ? Buffer.from(bundle) : undefined),
      put: async () => undefined,
    },
  });
  switch (id) {
    case 'blocks':
      return new BlocksEngine(gateway, { get: async () => Buffer.from(bundle) });
    case 'claude-code':
      return new ClaudeCodeEngine(withBundle(sandboxed(env.ANTHROPIC_API_KEY, env.AI_MODEL_AGENT)), {
        pricing: env.AI_PRICING,
        sitekit: env.GENERATION_CLAUDE_CODE_SITEKIT,
      });
    case 'claude-agent-sdk':
      return new ClaudeAgentSdkEngine(withBundle(sandboxed(env.ANTHROPIC_API_KEY, env.AI_MODEL_AGENT)), {
        pricing: env.AI_PRICING,
      });
    case 'codex':
      return new CodexEngine(withBundle(sandboxed(env.OPENAI_API_KEY, env.GENERATION_CODEX_MODEL)), {
        pricing: env.AI_PRICING,
        reasoningEffort: env.GENERATION_CODEX_REASONING_EFFORT,
      });
    default:
      throw new Error(`No benchmark for engine ${id}`);
  }
}

interface Row {
  readonly engine: EngineId;
  readonly business: string;
  readonly outcome: string;
  readonly valid: boolean;
  readonly factViolations: number;
  readonly lintErrors: number;
  readonly lintWarnings: number;
  readonly costUsd: number;
  readonly seconds: number;
  readonly toolCalls: number;
}

const only = values.only ? new Set(values.only.split(',')) : undefined;
const businesses = loadBusinesses()
  .filter((business) => !only || only.has(business.id))
  .slice(0, Number(values.limit));
const rows: Row[] = [];
for (const id of engineIds)
  for (const business of businesses) {
    const workspace = evalWorkspace(business);
    let spec: unknown;
    const ctx = {
      jobId: `bench-${id}-${business.id}`.slice(0, 80),
      attemptNo: 1,
      mode: 'create',
      organizationId: 'bench',
      workspace: { bundleRef: 'bundle' },
      brief: {
        businessName: business.businessName,
        pages: workspace.starter.pages.length,
        items: 0,
        locales: workspace.starter.locales,
      },
      budgetUsd: Number(values.budget),
      deadlineAt: new Date(Date.now() + 60 * 60_000),
      locales: workspace.starter.locales,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      writeSpec: async (written: unknown) => {
        spec = written;
        return 'spec';
      },
    } as unknown as EngineRunContext;
    const started = performance.now();
    const events: EngineEvent[] = [];
    for await (const event of engine(id, workspace.bundle).run(ctx, new AbortController().signal))
      events.push(event);
    const last = events.at(-1);
    const measured = spec ? measure(spec, workspace.facts) : undefined;
    rows.push({
      engine: id,
      business: business.id,
      outcome: last?.type === 'done' ? 'done' : last?.type === 'error' ? last.code : 'unknown',
      valid: measured?.valid ?? false,
      factViolations: measured?.factViolations ?? 0,
      lintErrors: measured?.lintErrors ?? 0,
      lintWarnings: measured?.lintWarnings ?? 0,
      costUsd: events.reduce((sum, event) => sum + (event.type === 'usage' ? event.costUsd : 0), 0),
      seconds: Math.round((performance.now() - started) / 100) / 10,
      toolCalls: events.filter((event) => event.type === 'tool_call').length,
    });
    console.log(`${id} ${business.id}: ${rows.at(-1)?.outcome} in ${rows.at(-1)?.seconds} s`);
  }

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] as number) : 0;
};
const summary = engineIds.map((id) => {
  const own = rows.filter((row) => row.engine === id);
  return {
    engine: id,
    runs: own.length,
    validRate: own.filter((row) => row.valid).length / Math.max(1, own.length),
    factViolations: own.reduce((sum, row) => sum + row.factViolations, 0),
    medianCostUsd: median(own.map((row) => row.costUsd)),
    medianSeconds: median(own.map((row) => row.seconds)),
    medianToolCalls: median(own.map((row) => row.toolCalls)),
  };
});
const lines = [
  `# Engine benchmark (${new Date().toISOString()})`,
  '',
  '| engine | runs | valid | fact violations | median cost | median duration | median tool calls |',
  '|---|---|---|---|---|---|---|',
  ...summary.map(
    (s) =>
      `| ${s.engine} | ${s.runs} | ${(s.validRate * 100).toFixed(0)}% | ${s.factViolations} | $${s.medianCostUsd.toFixed(3)} | ${s.medianSeconds} s | ${s.medianToolCalls} |`,
  ),
  '',
  '| engine | business | outcome | valid | facts | lint e/w | cost | s | tool calls |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.engine} | ${r.business} | ${r.outcome} | ${r.valid ? 'yes' : 'no'} | ${r.factViolations} | ${r.lintErrors}/${r.lintWarnings} | $${r.costUsd.toFixed(3)} | ${r.seconds} | ${r.toolCalls} |`,
  ),
];
const dir = new URL('../bench/reports/', new URL('.', DATASET));
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(new URL(`${stamp}.md`, dir), `${lines.join('\n')}\n`);
writeFileSync(new URL(`${stamp}.json`, dir), `${JSON.stringify({ summary, rows }, null, 2)}\n`);
console.log(lines.join('\n'));
