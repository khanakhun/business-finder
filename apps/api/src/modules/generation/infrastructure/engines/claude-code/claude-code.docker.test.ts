import type { EngineEvent } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import type { EngineRunContext } from '../../../application/ports.ts';
import { HttpDockerApi } from '../../sandbox/docker-engine.ts';
import { DockerSandboxProvider } from '../../sandbox/docker-sandbox.ts';
import { evalWorkspace, loadBusinesses } from '../blocks/eval/harness.ts';
import type { AgentRunPlan } from '../sandboxed/sandboxed-agent.engine.ts';
import { claudeCodeArgv } from './argv.ts';
import { ClaudeCodeEngine } from './claude-code.engine.ts';

// The Claude Code engine end to end on a real daemon and the runner image (BF-044): the real argv handed to a fake
// `claude` that speaks the stream format, sitekit edits inside the hardened sandbox, the supervisor's check, the
// artifacts back, and our validation outside. Runs when DOCKER_SANDBOX_IMAGE names a built image (the CI runner job;
// locally `pnpm runner:build` then DOCKER_SANDBOX_IMAGE=bf-agent-runner:dev).

const image = process.env.DOCKER_SANDBOX_IMAGE;
const host = process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock';

/** The engine with `claude` swapped for the scripted one: same arguments, same env. */
class FakeClaudeEngine extends ClaudeCodeEngine {
  constructor(
    deps: ConstructorParameters<typeof ClaudeCodeEngine>[0],
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

describe.runIf(Boolean(image))('ClaudeCodeEngine on a real sandbox', () => {
  const business = loadBusinesses().find((candidate) => candidate.id === 'salon-corail-gustavia-fr-rich');
  if (!business) throw new Error('missing eval business');
  const workspace = evalWorkspace(business);

  async function run(scenario: string) {
    const engine = new FakeClaudeEngine(
      {
        sandbox: new DockerSandboxProvider(new HttpDockerApi(host), { network: 'none', killGraceMs: 2000 }),
        artifacts: {
          get: async (key) => (key === 'bundle' ? Buffer.from(workspace.bundle) : undefined),
          put: async () => undefined,
        },
        keys: { resolve: async () => 'sk-ant-fake-docker-test' },
        settings: {
          enabled: true,
          image: image as string,
          cpus: 2,
          memoryMb: 2048,
          pidsLimit: 512,
          wallTimeSec: 180,
          maxTurns: 10,
          budgetMargin: 0.15,
          model: 'claude-opus-5-5',
        },
      },
      scenario,
    );
    const specs: unknown[] = [];
    const ctx = {
      jobId: `docker-${scenario}-${Date.now()}`,
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

  it('runs the agent to a checked, validated site', async () => {
    const { events, specs } = await run('success');
    expect(events.at(-1)).toEqual({ type: 'done', siteSpecRef: 'spec-ref' });
    expect(events.some((e) => e.type === 'log' && /claude 2\.1\.288/.test(e.message))).toBe(true);
    expect(events.some((e) => e.type === 'tool_call' && /sitekit ops apply/.test(e.summary))).toBe(true);
    expect(events.some((e) => e.type === 'file_change')).toBe(true);
    expect(JSON.stringify(specs[0])).toContain('Salon Corail, sur le port de Gustavia');
    expect(JSON.stringify(events)).not.toContain('sk-ant-fake-docker-test');
  }, 240_000);

  it('reports an agent that ran out of turns as incomplete', async () => {
    const { events, specs } = await run('max_turns');
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'ENGINE_INCOMPLETE', retryable: true });
    expect(specs).toEqual([]);
  }, 240_000);
});
