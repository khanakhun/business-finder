import type { EngineEvent } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import type { EngineRunContext } from '../../../application/ports.ts';
import { HttpDockerApi } from '../../sandbox/docker-engine.ts';
import { DockerSandboxProvider } from '../../sandbox/docker-sandbox.ts';
import { evalWorkspace, loadBusinesses } from '../blocks/eval/harness.ts';
import { ClaudeAgentSdkEngine } from '../claude-agent-sdk/claude-agent-sdk.engine.ts';
import { claudeCodeArgv } from '../claude-code/argv.ts';
import { ClaudeCodeEngine } from '../claude-code/claude-code.engine.ts';
import { codexArgv } from '../codex/argv.ts';
import { CodexEngine } from '../codex/codex.engine.ts';
import type { AgentRunPlan, SandboxedEngineDeps } from './sandboxed-agent.engine.ts';

// The coding-agent engines end to end on a real daemon and the runner image (BF-044): each engine's real argv handed
// to a fake CLI that speaks its stream format, sitekit edits inside the hardened sandbox, the supervisor's check, the
// artifacts back, and our validation outside. Runs when DOCKER_SANDBOX_IMAGE names a built image (the CI runner job;
// locally `pnpm runner:build` then DOCKER_SANDBOX_IMAGE=bf-agent-runner:dev).

const image = process.env.DOCKER_SANDBOX_IMAGE;
const host = process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock';
const KEY = 'sk-fake-docker-test-0000';

/** Claude Code with `claude` swapped for the scripted one: same arguments, same env. */
class FakeClaudeEngine extends ClaudeCodeEngine {
  constructor(
    deps: SandboxedEngineDeps,
    private readonly scenario: string,
  ) {
    super(deps, { pricing: {} });
  }
  protected override command(plan: AgentRunPlan): string[] {
    return ['node', '/opt/runner/fake-claude.mjs', ...claudeCodeArgv(plan).slice(1)];
  }
  protected override env(): Record<string, string> {
    return { ...super.env(), FAKE_CLAUDE_SCENARIO: this.scenario };
  }
}

class FakeCodexEngine extends CodexEngine {
  constructor(
    deps: SandboxedEngineDeps,
    private readonly scenario: string,
  ) {
    super(deps, { pricing: {}, reasoningEffort: 'low' });
  }
  protected override command(plan: AgentRunPlan): string[] {
    return ['node', '/opt/runner/fake-codex.mjs', ...codexArgv(plan, { reasoningEffort: 'low' }).slice(1)];
  }
  protected override env(): Record<string, string> {
    return { ...super.env(), FAKE_CODEX_SCENARIO: this.scenario };
  }
}

describe.runIf(Boolean(image))('coding-agent engines on a real sandbox', () => {
  const business = loadBusinesses().find((candidate) => candidate.id === 'salon-corail-gustavia-fr-rich');
  if (!business) throw new Error('missing eval business');
  const workspace = evalWorkspace(business);
  const deps = (model: string, wallTimeSec = 180): SandboxedEngineDeps => ({
    sandbox: new DockerSandboxProvider(new HttpDockerApi(host), { network: 'none', killGraceMs: 2000 }),
    artifacts: {
      get: async (key) => (key === 'bundle' ? Buffer.from(workspace.bundle) : undefined),
      put: async () => undefined,
    },
    keys: { resolve: async () => KEY },
    settings: {
      enabled: true,
      image: image as string,
      cpus: 2,
      memoryMb: 2048,
      pidsLimit: 512,
      wallTimeSec,
      maxTurns: 10,
      budgetMargin: 0.15,
      model,
    },
  });

  async function run(engine: ClaudeCodeEngine | CodexEngine | ClaudeAgentSdkEngine, name: string) {
    const specs: unknown[] = [];
    const ctx = {
      jobId: `docker-${name}-${Date.now()}`,
      attemptNo: 1,
      mode: 'create',
      organizationId: 'org-docker',
      workspace: { bundleRef: 'bundle' },
      brief: { businessName: business?.businessName, pages: 1, items: 1, locales: workspace.starter.locales },
      budgetUsd: 1,
      deadlineAt: new Date(Date.now() + 180_000),
      locales: workspace.starter.locales,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      writeSpec: async (spec: unknown) => {
        specs.push(spec);
        return 'spec-ref';
      },
    } as unknown as EngineRunContext;
    const events: EngineEvent[] = [];
    for await (const event of engine.run(ctx, new AbortController().signal)) events.push(event);
    return { events, specs };
  }

  it('Claude Code runs to a checked, validated site', async () => {
    const { events, specs } = await run(new FakeClaudeEngine(deps('claude-opus-5-5'), 'success'), 'claude');
    expect(events.at(-1)).toEqual({ type: 'done', siteSpecRef: 'spec-ref' });
    expect(events.some((e) => e.type === 'log' && /claude 2\.1\.288/.test(e.message))).toBe(true);
    expect(events.some((e) => e.type === 'tool_call' && /sitekit ops apply/.test(e.summary))).toBe(true);
    expect(events.some((e) => e.type === 'file_change')).toBe(true);
    expect(JSON.stringify(specs[0])).toContain('Salon Corail, sur le port de Gustavia');
    expect(JSON.stringify(events)).not.toContain(KEY);
  }, 240_000);

  it('Claude Code out of turns is incomplete', async () => {
    const { events, specs } = await run(
      new FakeClaudeEngine(deps('claude-opus-5-5'), 'max_turns'),
      'claude-turns',
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'ENGINE_INCOMPLETE', retryable: true });
    expect(specs).toEqual([]);
  }, 240_000);

  it('Codex runs to a checked, validated site', async () => {
    const { events, specs } = await run(new FakeCodexEngine(deps('gpt-6.1-sol'), 'success'), 'codex');
    expect(events.at(-1)).toEqual({ type: 'done', siteSpecRef: 'spec-ref' });
    expect(events.some((e) => e.type === 'log' && /codex .*0\.160\.0/.test(e.message))).toBe(true);
    expect(events.some((e) => e.type === 'file_change')).toBe(true);
    expect(events.some((e) => e.type === 'log' && /self-assessed 3\/5/.test(e.message))).toBe(true);
    expect(JSON.stringify(specs[0])).toContain('Salon Corail, au bord du port');
  }, 240_000);

  it('a failed Codex turn is incomplete', async () => {
    const { events, specs } = await run(
      new FakeCodexEngine(deps('gpt-6.1-sol'), 'turn_failed'),
      'codex-failed',
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'ENGINE_INCOMPLETE', retryable: true });
    expect(specs).toEqual([]);
  }, 240_000);

  // The real CLIs, offline (no network, a fake key): they must accept our exact argv and env and start with the tools
  // we allow — then they wait for the model API until the wall time ends the run. Found this way: Claude Code's
  // subprocess env scrub needs bubblewrap, which the sandbox cannot run.
  const agentStarted = (events: EngineEvent[]) =>
    events.find((e) => e.type === 'log' && e.message.startsWith('Agent started:'));

  it('real Claude Code accepts the argv and env and starts with exactly its tools', async () => {
    const { events } = await run(
      new ClaudeCodeEngine(deps('claude-opus-5-5', 20), { pricing: {} }),
      'real-claude',
    );
    expect(agentStarted(events)).toMatchObject({
      message: 'Agent started: claude-opus-5-5; tools Bash, Edit, Glob, Grep, Read, StructuredOutput, Write.',
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'TIMEOUT' });
  }, 120_000);

  it('the real Agent SDK runner starts the image’s CLI with file tools and sitekit over MCP, no shell', async () => {
    const { events } = await run(
      new ClaudeAgentSdkEngine(deps('claude-opus-5-5', 30), { pricing: {} }),
      'real-sdk',
    );
    const started = agentStarted(events);
    expect(started?.type === 'log' && started.message).toMatch(
      /tools Edit, Glob, Grep, Read, StructuredOutput, Write, mcp__sitekit__/,
    );
    expect(started?.type === 'log' && started.message).not.toMatch(/\bBash\b|WebFetch|WebSearch/);
    expect(events.some((e) => e.type === 'log' && /claude 2\.1\.288/.test(e.message))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  }, 120_000);

  it('real Codex accepts the argv and ends its turn as failed without the API', async () => {
    const { events } = await run(
      new CodexEngine(deps('gpt-6.1-sol', 120), { pricing: {}, reasoningEffort: 'low' }),
      'real-codex',
    );
    expect(agentStarted(events)).toBeDefined();
    expect(events.some((e) => e.type === 'log' && e.level === 'warn' && /Reconnecting/.test(e.message))).toBe(
      true,
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', retryable: true });
    expect(JSON.stringify(events)).not.toContain(KEY);
  }, 240_000);
});
