import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type EngineEvent, EngineEventSchema } from '@bf/contracts';
import type { RunnerFrame, RunnerInput } from '@bf/contracts/runner';
import type { SandboxRunSpec } from '@bf/contracts/sandbox';
import { describe, expect, it } from 'vitest';
import type { EngineRunContext } from '../../../application/ports.ts';
import { SandboxError, type SandboxProvider } from '../../../application/sandbox.ports.ts';
import { unpackBundle } from '../../workspace/tar.ts';
import { evalWorkspace, loadBusinesses } from '../blocks/eval/harness.ts';
import { ClaudeCodeEngine } from '../claude-code/claude-code.engine.ts';
import { CodexEngine } from '../codex/codex.engine.ts';
import type { SandboxedEngineSettings } from './sandboxed-agent.engine.ts';

// The sandboxed base (BF-044) through the Claude Code engine, on a real workspace (an eval business) and a scripted
// sandbox provider: the run's input, the events, the version gate, the budget guard, the in-sandbox check and the
// validation outside the sandbox, repair mode, and secrets kept out of events.

const KEY = 'sk-ant-test-key-0000000000000000';
const FIXTURES = new URL('../__fixtures__/streams/claude-code/', import.meta.url);
const stream = (name: string) =>
  readFileSync(new URL(`${name}.jsonl`, FIXTURES), 'utf8')
    .split('\n')
    .filter(Boolean);
const [business] = loadBusinesses();
if (!business) throw new Error('no eval business');
const workspace = evalWorkspace(business);

const artifact = (name: string, body: Buffer): RunnerFrame[] => [
  {
    t: 'artifact',
    name,
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    seq: 0,
    last: true,
    data: body.toString('base64'),
  },
];

/** The site the "agent" wrote: the starter with a new hero title (or anything given). */
const written = (change?: (site: Record<string, unknown>) => void) => {
  const site = structuredClone(workspace.starter) as unknown as {
    pages: { blocks: { type: string; props: Record<string, unknown> }[] }[];
  };
  const hero = site.pages[0]?.blocks.find((block) => block.type === 'hero');
  if (hero)
    hero.props.title = Object.fromEntries(
      workspace.starter.locales.map((l) => [l, 'Salon Corail, Gustavia']),
    );
  change?.(site as unknown as Record<string, unknown>);
  return Buffer.from(JSON.stringify(site));
};

interface Script {
  readonly version?: string;
  readonly lines?: readonly string[];
  readonly check?: { exitCode: number; done: boolean } | null;
  readonly site?: Buffer | null;
  readonly exit?: Extract<RunnerFrame, { t: 'exit' }>;
  readonly throws?: Error;
}

class ScriptedSandbox implements SandboxProvider {
  readonly id = 'scripted';
  input?: RunnerInput;
  spec?: SandboxRunSpec;
  bundle?: Uint8Array;
  aborted = false;
  constructor(private readonly script: Script) {}
  async ready() {
    return { ready: true };
  }
  async *run(spec: SandboxRunSpec, input: RunnerInput, bundle: Uint8Array, signal: AbortSignal) {
    this.spec = spec;
    this.input = input;
    this.bundle = bundle;
    signal.addEventListener('abort', () => {
      this.aborted = true;
    });
    yield {
      t: 'versions',
      protocol: 1,
      versions: { claude: this.script.version ?? '2.1.288 (Claude Code)', codex: 'codex-cli 0.160.0' },
    } as RunnerFrame;
    if (signal.aborted) return;
    for (const line of this.script.lines ?? stream('success')) {
      if (signal.aborted) return;
      yield { t: 'engine', line } as RunnerFrame;
    }
    yield { t: 'heartbeat', at: '2026-10-17T08:00:00.000Z' } as RunnerFrame;
    if (this.script.throws) throw this.script.throws;
    if (this.script.check !== null) {
      const check = this.script.check ?? { exitCode: 0, done: true };
      yield {
        t: 'check',
        exitCode: check.exitCode,
        report: { command: 'check', ok: check.done, exitCode: check.exitCode, data: { done: check.done } },
      } as RunnerFrame;
    }
    if (this.script.site !== null) yield* artifact('site.json', this.script.site ?? written());
    yield* artifact('.sitekit/screenshots/home-desktop.png', Buffer.from('png-bytes'));
    yield this.script.exit ?? ({ t: 'exit', code: 0, reason: 'completed' } as RunnerFrame);
  }
}

const SETTINGS: SandboxedEngineSettings = {
  enabled: true,
  image: 'bf-agent-runner:dev',
  cpus: 2,
  memoryMb: 4096,
  pidsLimit: 512,
  wallTimeSec: 900,
  maxTurns: 60,
  budgetMargin: 0.15,
  model: 'claude-opus-5-5',
};
const PRICING = { 'claude-opus-5-5': { inputPerMTok: 5, outputPerMTok: 25, cachedInputPerMTok: 0.5 } };

async function run(
  script: Script,
  overrides: Partial<EngineRunContext> = {},
  options: { key?: string | undefined; objects?: Record<string, Buffer> } = {},
) {
  const sandbox = new ScriptedSandbox(script);
  const stored = new Map<string, Buffer>(Object.entries(options.objects ?? {}));
  const engine = new ClaudeCodeEngine(
    {
      sandbox,
      artifacts: {
        get: async (key) => (key === 'bundle' ? Buffer.from(workspace.bundle) : stored.get(key)),
        put: async (key, body) => {
          stored.set(key, body);
        },
      },
      keys: { resolve: async () => ('key' in options ? options.key : KEY) },
      settings: SETTINGS,
    },
    { pricing: PRICING },
  );
  const specs: unknown[] = [];
  const ctx = {
    jobId: 'job-1',
    attemptNo: 1,
    mode: 'create',
    organizationId: 'org-1',
    workspace: { bundleRef: 'bundle' },
    brief: { businessName: business?.businessName, pages: 2, items: 4, locales: workspace.starter.locales },
    budgetUsd: 2,
    deadlineAt: new Date(Date.now() + 60_000),
    locales: workspace.starter.locales,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    writeSpec: async (spec: unknown) => {
      specs.push(spec);
      return 'spec-ref';
    },
    ...overrides,
  } as unknown as EngineRunContext;
  const events: EngineEvent[] = [];
  for await (const event of engine.run(ctx, new AbortController().signal)) events.push(event);
  return { events, sandbox, stored, specs, engine };
}

const last = (events: EngineEvent[]) => events.at(-1);

describe('SandboxedAgentEngine (Claude Code)', () => {
  it('runs the agent in a models-only sandbox with a per-run key and accepts a checked, valid site', async () => {
    const { events, sandbox, stored, specs } = await run({});
    expect(last(events)).toEqual({ type: 'done', siteSpecRef: 'spec-ref' });
    for (const event of events) expect(EngineEventSchema.safeParse(event).success).toBe(true);
    // The run's input: argv only, the key as a named secret, the collected files.
    expect(sandbox.input?.command[0]).toBe('claude');
    expect(sandbox.input?.env?.ANTHROPIC_API_KEY).toBe(KEY);
    expect(sandbox.input?.secrets).toEqual(['ANTHROPIC_API_KEY']);
    expect(sandbox.input?.collect).toContain('site.json');
    expect(sandbox.spec).toMatchObject({ egressProfile: 'models', labels: { 'bf.engine': 'claude-code' } });
    // The workspace carries our rules and the report schema.
    const files = unpackBundle(Buffer.from(sandbox.bundle ?? new Uint8Array()));
    expect(files.get('AGENTS.md')?.toString()).toMatch(/Edit only `site.json`/);
    expect(files.has('.prompts/final-report.schema.json')).toBe(true);
    expect(files.has('ISSUES.md')).toBe(false);
    // Events: tool calls with progress, the usage, the agent's report, a screenshot, the site.
    expect(events.filter((e) => e.type === 'tool_call').length).toBe(6);
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ costUsd: 0.62 });
    expect(events.some((e) => e.type === 'log' && /self-assessed 4\/5/.test(e.message))).toBe(true);
    expect(events.filter((e) => e.type === 'artifact').map((e) => e.type === 'artifact' && e.kind)).toEqual([
      'screenshot',
      'site_spec',
    ]);
    expect([...stored.keys()].some((key) => key.endsWith('.png'))).toBe(true);
    expect(JSON.stringify(specs[0])).toContain('Salon Corail, Gustavia');
    // Its budget leaves the margin: 2 × (1 − 0.15).
    expect(sandbox.input?.command[sandbox.input.command.indexOf('--max-budget-usd') + 1]).toBe('1.70');
  });

  it('refuses a CLI version its parser was not written for', async () => {
    const { events, sandbox } = await run({ version: '3.0.1 (Claude Code)' });
    expect(last(events)).toMatchObject({
      type: 'error',
      code: 'ENGINE_VERSION_UNSUPPORTED',
      retryable: false,
    });
    expect(sandbox.aborted).toBe(true);
  });

  it('stops the agent when its spend reaches the attempt budget', async () => {
    // Before the result, the parser prices the tokens: a budget of a cent is spent by the first message.
    const { events, sandbox } = await run({}, { budgetUsd: 0.01 });
    expect(last(events)).toMatchObject({ type: 'error', code: 'ENGINE_BUDGET_EXCEEDED', retryable: false });
    expect(sandbox.aborted).toBe(true);
    expect(events.find((e) => e.type === 'usage')).toBeDefined();
  });

  it('types the agent’s own endings and an unfinished check', async () => {
    expect(last((await run({ lines: stream('max-turns') })).events)).toMatchObject({
      code: 'ENGINE_INCOMPLETE',
    });
    expect(last((await run({ lines: stream('budget-exceeded') })).events)).toMatchObject({
      code: 'ENGINE_BUDGET_EXCEEDED',
    });
    expect(last((await run({ check: { exitCode: 1, done: false } })).events)).toMatchObject({
      code: 'ENGINE_INCOMPLETE',
      retryable: true,
    });
    expect(last((await run({ check: null })).events)).toMatchObject({ code: 'ENGINE_INCOMPLETE' });
    expect(last((await run({ exit: { t: 'exit', code: 124, reason: 'timeout' } })).events)).toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    });
    expect(
      last((await run({ throws: new SandboxError('SANDBOX_OOM', 'out of memory') })).events),
    ).toMatchObject({
      code: 'SANDBOX_OOM',
      retryable: true,
    });
    expect(last((await run({}, {}, { key: undefined })).events)).toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
    });
  });

  it('rejects a site that passed the agent’s check but not ours: an invented award, an unreadable or missing site', async () => {
    // A prompt injection in context/ made the agent claim an award that is not among the facts.
    const award = written((site) => {
      const page = (site as { pages: { blocks: { type: string; props: Record<string, unknown> }[] }[] })
        .pages[0];
      const hero = page?.blocks.find((block) => block.type === 'hero');
      if (hero)
        hero.props.subtitle = Object.fromEntries(
          workspace.starter.locales.map((l) => [l, 'Élu meilleur salon des Caraïbes, n°1 depuis 1987']),
        );
    });
    const rejected = await run({ site: award });
    expect(last(rejected.events)).toMatchObject({
      type: 'error',
      code: 'ENGINE_INVALID_OUTPUT',
      retryable: true,
    });
    expect(last(rejected.events)).toMatchObject({
      message: expect.stringMatching(/superlative|1987|unsupported/i),
    });
    expect(rejected.specs).toEqual([]);
    expect(last((await run({ site: Buffer.from('{not json') })).events)).toMatchObject({
      code: 'ENGINE_INVALID_OUTPUT',
    });
    expect(last((await run({ site: null })).events)).toMatchObject({ code: 'ENGINE_INVALID_OUTPUT' });
  });

  it('repairs from the previous site with the issues written into the workspace', async () => {
    const base = written();
    const { events, sandbox } = await run(
      {},
      {
        mode: 'repair',
        repair: {
          baseSpecRef: 'previous/site.json',
          issues: [
            {
              path: ['pages', 0, 'blocks', 0, 'props', 'title', 'fr'],
              code: 'text_length',
              severity: 'error',
              message: 'Shorten the title.',
            },
          ],
        },
      } as never,
      { objects: { 'previous/site.json': base } },
    );
    expect(last(events)?.type).toBe('done');
    const files = unpackBundle(Buffer.from(sandbox.bundle ?? new Uint8Array()));
    expect(files.get('site.json')?.toString()).toContain('Salon Corail, Gustavia');
    expect(files.get('ISSUES.md')?.toString()).toContain(
      '`pages[0].blocks[0].props.title.fr`: Shorten the title.',
    );
    expect(JSON.parse(files.get('issues.json')?.toString() ?? '[]')).toHaveLength(1);
    expect(files.get('AGENTS.md')?.toString()).toMatch(/Change only what the issues require/);
    expect(sandbox.input?.command[2]).toMatch(/^Repair the preview site/);
  });

  it('never lets the key into an event, even when the agent prints it', async () => {
    const leak = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'm',
        content: [{ type: 'text', text: `my key is ${KEY}` }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const { events } = await run({ lines: [leak, ...stream('success')] });
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(events)).toContain('[redacted]');
  });

  it('is available only with sandboxes on, a key and a ready image', async () => {
    const { engine } = await run({});
    expect(await engine.available('org-1')).toBe(true);
    const off = new ClaudeCodeEngine(
      {
        sandbox: new ScriptedSandbox({}),
        artifacts: { get: async () => undefined, put: async () => undefined },
        keys: { resolve: async () => KEY },
        settings: { ...SETTINGS, enabled: false },
      },
      { pricing: {} },
    );
    expect(await off.available('org-1')).toBe(false);
  });

  it('Codex: prices its tokens at the end of the turn and refuses a run that spent the budget', async () => {
    const codexStream = readFileSync(
      new URL('../__fixtures__/streams/codex/success.jsonl', import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter(Boolean);
    const runCodex = async (inputPerMTok: number) => {
      const sandbox = new ScriptedSandbox({ lines: codexStream });
      const engine = new CodexEngine(
        {
          sandbox,
          artifacts: { get: async () => Buffer.from(workspace.bundle), put: async () => undefined },
          keys: { resolve: async () => KEY },
          settings: { ...SETTINGS, model: 'gpt-6.1-sol' },
        },
        {
          pricing: { 'gpt-6.1-sol': { inputPerMTok, outputPerMTok: 12, cachedInputPerMTok: 0.2 } },
          reasoningEffort: 'high',
        },
      );
      const ctx = {
        jobId: 'job-c',
        attemptNo: 1,
        mode: 'create',
        organizationId: 'org-1',
        workspace: { bundleRef: 'bundle' },
        brief: {},
        budgetUsd: 2,
        deadlineAt: new Date(Date.now() + 60_000),
        locales: workspace.starter.locales,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        writeSpec: async () => 'spec-ref',
      } as unknown as EngineRunContext;
      const events: EngineEvent[] = [];
      for await (const event of engine.run(ctx, new AbortController().signal)) events.push(event);
      return { events, sandbox };
    };
    const cheap = await runCodex(2);
    expect(last(cheap.events)?.type).toBe('done');
    expect(cheap.sandbox.input?.env?.CODEX_API_KEY).toBe(KEY);
    expect(cheap.sandbox.input?.command.slice(0, 2)).toEqual(['codex', 'exec']);
    const usage = cheap.events.find((e) => e.type === 'usage');
    expect(usage?.type === 'usage' && usage.costUsd).toBeGreaterThan(0.1);
    // 34k uncached input tokens at $100/M: past the $2 budget when the turn ends.
    const dear = await runCodex(100);
    expect(last(dear.events)).toMatchObject({ code: 'ENGINE_BUDGET_EXCEEDED', retryable: false });
  });
});
