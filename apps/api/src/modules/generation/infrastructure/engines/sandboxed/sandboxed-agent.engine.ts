import { createHash } from 'node:crypto';
import {
  type EngineCapabilities,
  type EngineEvent,
  EngineFinalReportSchema,
  type EngineId,
  GenerationBriefSchema,
} from '@bf/contracts';
import { RUNNER_PROTOCOL, type RunnerFrame, type RunnerInput } from '@bf/contracts/runner';
import type { SandboxRunSpec } from '@bf/contracts/sandbox';
import { parseFacts, SitekitConfigSchema } from '@bf/sitekit';
import type { AgentEngine, ArtifactStore, EngineRunContext } from '../../../application/ports.ts';
import { SandboxError, type SandboxProvider } from '../../../application/sandbox.ports.ts';
import { packBundle, unpackBundle } from '../../workspace/tar.ts';
import { AGENT_PATHS, type RepairInput, renderAgentWorkspace } from './agent-workspace.ts';
import { ArtifactCollector, type VersionRange, validateOutput, versionSupported } from './run-pieces.ts';

// The coding-agent engines' common run (BF-044, Template Method): render our rules into the attempt's workspace, start
// the agent in a sandbox (BF-043) with a per-run key, turn its stream into engine events while tracking its spend
// against the budget, then accept its site only if the in-sandbox `sitekit check` passed AND our own validation —
// strict facts against the job's registry, outside the sandbox — passes. Engines supply the argv, the env and the
// stream parser.

export type AgentFailure = { readonly code: string; readonly message: string; readonly retryable: boolean };

/** An agent's stream turned into engine events (Adapter); unknown lines never throw. */
export interface AgentStreamParser {
  line(text: string): EngineEvent[];
  /** Spend so far: the agent's own figure once it reports one, else its tokens priced (null when unpriced). */
  costUsd(): number | null;
  tokens(): { readonly input: number; readonly output: number };
  /** How the agent ended: its final report (raw), or the failure its last message describes. */
  outcome(): { readonly report?: unknown; readonly failure?: AgentFailure };
}

/** What an engine's argv needs. */
export interface AgentRunPlan {
  readonly task: string;
  readonly system: string;
  readonly reportSchema: Record<string, unknown>;
  readonly model: string;
  readonly maxTurns: number;
  /** The agent's own budget: the attempt's, minus the safety margin. */
  readonly budgetUsd: number;
  readonly repair: boolean;
}

export interface SandboxedEngineSettings {
  readonly enabled: boolean;
  readonly image: string;
  readonly cpus: number;
  readonly memoryMb: number;
  readonly pidsLimit: number;
  readonly wallTimeSec: number;
  readonly maxTurns: number;
  /** Share of the attempt's budget kept back from the agent (it may overshoot by one turn). */
  readonly budgetMargin: number;
  readonly model: string;
}

export interface SandboxedEngineDeps {
  readonly sandbox: SandboxProvider;
  readonly artifacts: Pick<ArtifactStore, 'get' | 'put'>;
  /** The workspace's own model key (the vault), passed to the sandbox for this run only. */
  readonly keys: { resolve(organizationId: string): Promise<string | undefined> };
  readonly settings: SandboxedEngineSettings;
}

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

class RunFailure extends Error {
  constructor(readonly failure: AgentFailure) {
    super(failure.message);
  }
}

const fail = (code: string, message: string, retryable: boolean) =>
  new RunFailure({ code, message: message.slice(0, 1000), retryable });

export abstract class SandboxedAgentEngine implements AgentEngine {
  abstract readonly id: EngineId;
  abstract readonly capabilities: EngineCapabilities;
  /** The env var the agent reads its key from. */
  protected abstract readonly keyEnv: string;
  /** The supervisor's `versions` key for this agent's CLI, and the range this engine's parser was written for. */
  protected abstract readonly versionKey: string;
  protected abstract readonly versionRange: VersionRange;

  constructor(protected readonly deps: SandboxedEngineDeps) {}

  /** The agent's command line (argv only, no shell). */
  protected abstract command(plan: AgentRunPlan): string[];
  /** Non-secret env (telemetry and updates off…); the key is added by the base. */
  protected abstract env(plan: AgentRunPlan): Record<string, string>;
  protected abstract parser(): AgentStreamParser;

  async available(organizationId: string): Promise<boolean> {
    if (!this.deps.settings.enabled) return false;
    if (!(await this.deps.keys.resolve(organizationId).catch(() => undefined))) return false;
    return (await this.deps.sandbox.ready(this.deps.settings.image).catch(() => ({ ready: false }))).ready;
  }

  /** The sandbox's size and isolation: models-only egress, labels naming the job. */
  protected sandboxSpec(ctx: EngineRunContext): SandboxRunSpec {
    const { settings } = this.deps;
    return {
      image: settings.image,
      cpus: settings.cpus,
      memoryMb: settings.memoryMb,
      pidsLimit: settings.pidsLimit,
      tmpfsMb: { workspace: 512, tmp: 512, home: 256 },
      wallTimeSec: settings.wallTimeSec,
      egressProfile: 'models',
      labels: {
        'bf.job': ctx.jobId,
        'bf.attempt': String(ctx.attemptNo),
        'bf.org': ctx.organizationId,
        'bf.engine': this.id,
      },
    };
  }

  async *run(ctx: EngineRunContext, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { settings } = this.deps;
    let key: string | undefined;
    const redact = (event: EngineEvent): EngineEvent => {
      if (!key) return event;
      const text = JSON.stringify(event);
      return text.includes(key) ? (JSON.parse(text.split(key).join('[redacted]')) as EngineEvent) : event;
    };
    try {
      yield { type: 'status', phase: 'preparing' };
      key = await this.deps.keys.resolve(ctx.organizationId);
      if (!key)
        throw fail('ENGINE_UNAVAILABLE', `No ${this.keyEnv} is configured for this workspace.`, false);

      // 1. The workspace, with our rules (and the site to repair).
      const bundle = await this.deps.artifacts.get(ctx.workspace.bundleRef);
      if (!bundle) throw fail('INVALID_BRIEF', 'The workspace bundle is missing.', true);
      const files = unpackBundle(bundle);
      const json = (name: string) => {
        const body = files.get(name);
        if (!body) throw fail('INVALID_BRIEF', `The workspace has no ${name}.`, false);
        return JSON.parse(body.toString('utf8')) as unknown;
      };
      const brief = GenerationBriefSchema.parse(json('brief.json'));
      // The job's registry, kept on this side: the result is checked against it, never the agent's copy.
      const registry = {
        facts: parseFacts(json('facts.json')),
        config: SitekitConfigSchema.parse(files.has('.sitekit.json') ? json('.sitekit.json') : {}),
      };
      let repair: RepairInput | undefined;
      if (ctx.mode === 'repair' && ctx.repair) {
        const base = await this.deps.artifacts.get(ctx.repair.baseSpecRef).catch(() => undefined);
        if (base) repair = { spec: JSON.parse(base.toString('utf8')) as unknown, issues: ctx.repair.issues };
      }
      const budgetUsd = Math.max(0.01, ctx.budgetUsd * (1 - settings.budgetMargin));
      const rendered = renderAgentWorkspace(files, {
        brief,
        locales: ctx.locales,
        budgetUsd,
        maxTurns: settings.maxTurns,
        ...(repair ? { repair } : {}),
      });
      const plan: AgentRunPlan = {
        task: rendered.task,
        system: rendered.system,
        reportSchema: rendered.reportSchema,
        model: settings.model,
        maxTurns: settings.maxTurns,
        budgetUsd,
        repair: Boolean(repair),
      };
      const input: RunnerInput = {
        protocol: RUNNER_PROTOCOL,
        runId: `${ctx.jobId}:${ctx.attemptNo}`.slice(0, 100),
        command: this.command(plan),
        env: { ...this.env(plan), [this.keyEnv]: key },
        secrets: [this.keyEnv],
        wallTimeSec: settings.wallTimeSec,
        collect: ['site.json', '.sitekit/screenshots/*.png', AGENT_PATHS.report],
        limits: { maxArtifactBytes: MAX_ARTIFACT_BYTES, maxBundleBytes: MAX_ARTIFACT_BYTES },
      };
      yield {
        type: 'log',
        level: 'info',
        message: `${this.id} in a sandbox: ${settings.model}, up to ${settings.maxTurns} turns, $${budgetUsd.toFixed(2)} and ${Math.round(settings.wallTimeSec / 60)} min${repair ? `, repairing ${repair.issues.length} issue(s)` : ''}.`,
      };

      // 2. The run.
      yield { type: 'status', phase: 'running' };
      const parser = this.parser();
      const collector = new ArtifactCollector(MAX_ARTIFACT_BYTES);
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal.addEventListener('abort', stop, { once: true });
      let check: Extract<RunnerFrame, { t: 'check' }> | undefined;
      let exit: Extract<RunnerFrame, { t: 'exit' }> | undefined;
      let budgetExceeded = false;
      let unsupported: string | undefined;
      let calls = 0;
      try {
        for await (const frame of this.deps.sandbox.run(
          this.sandboxSpec(ctx),
          input,
          packBundle(rendered.files),
          controller.signal,
        )) {
          if (frame.t === 'versions') {
            const reported = frame.versions[this.versionKey];
            if (!versionSupported(reported, this.versionRange)) {
              unsupported = reported ?? 'missing';
              controller.abort();
              break;
            }
            yield { type: 'log', level: 'info', message: `${this.versionKey} ${reported}` };
          } else if (frame.t === 'engine') {
            for (const event of parser.line(frame.line)) {
              if (event.type === 'tool_call') {
                calls++;
                yield {
                  type: 'progress',
                  pct: Math.min(85, 10 + calls * 2),
                  label: event.summary.slice(0, 200),
                };
              }
              yield redact(event);
            }
            const spent = parser.costUsd();
            if (spent !== null && spent >= ctx.budgetUsd) {
              budgetExceeded = true;
              controller.abort();
              break;
            }
          } else if (frame.t === 'heartbeat') yield { type: 'heartbeat' };
          else if (frame.t === 'check') {
            check = frame;
            yield { type: 'progress', pct: 90, label: 'sitekit check' };
          } else if (frame.t === 'artifact') collector.add(frame);
          else if (frame.t === 'exit') exit = frame;
        }
      } catch (error) {
        if (signal.aborted) throw error;
        if (!budgetExceeded && !unsupported) {
          if (error instanceof SandboxError) throw fail(error.code, error.message, true);
          throw error;
        }
      } finally {
        signal.removeEventListener('abort', stop);
      }
      if (signal.aborted) throw signal.reason ?? new Error('aborted');

      // 3. What the agent spent, and how it ended.
      const tokens = parser.tokens();
      yield {
        type: 'usage',
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        costUsd: parser.costUsd() ?? 0,
      };
      if (parser.costUsd() === null)
        yield {
          type: 'log',
          level: 'warn',
          message: `${settings.model} has no price in AI_PRICING: this run's spend was not tracked against the budget.`,
        };
      if (unsupported)
        throw fail(
          'ENGINE_VERSION_UNSUPPORTED',
          `${this.versionKey} ${unsupported} is outside ${this.versionRange.min}–<${this.versionRange.below}.`,
          false,
        );
      if (budgetExceeded)
        throw fail(
          'ENGINE_BUDGET_EXCEEDED',
          `The agent spent the attempt's $${ctx.budgetUsd.toFixed(2)}.`,
          false,
        );
      // A run stopped at its wall time has no result of its own: the timeout is the reason.
      if (exit?.reason === 'timeout') throw fail('TIMEOUT', 'The agent ran out of wall time.', true);
      const outcome = parser.outcome();
      if (outcome.failure) throw new RunFailure(outcome.failure);
      if (!exit) throw fail('SANDBOX_PROTOCOL_ERROR', 'The sandbox ended without an exit frame.', true);
      if (exit.reason !== 'completed')
        throw fail(
          exit.reason === 'failed' ? 'ENGINE_INCOMPLETE' : 'ENGINE_ERROR',
          `The agent ended: ${exit.reason}${exit.message ? ` (${exit.message})` : ''}.`,
          true,
        );
      const report = check?.report as { data?: { done?: unknown } } | null | undefined;
      if (!check || check.exitCode !== 0 || report?.data?.done !== true)
        throw fail('ENGINE_INCOMPLETE', 'The agent stopped before `sitekit check` passed.', true);

      // 4. Our own validation, outside the sandbox.
      yield { type: 'status', phase: 'validating' };
      const validation = validateOutput(collector.get('site.json'), registry);
      if (!validation.ok)
        throw fail(
          'ENGINE_INVALID_OUTPUT',
          `${validation.reason}${
            validation.issues.length
              ? ` First: ${validation.issues
                  .slice(0, 3)
                  .map((issue) => `${issue.at}: ${issue.message}`)
                  .join('; ')}`
              : ''
          }`,
          true,
        );
      const final = EngineFinalReportSchema.safeParse(outcome.report);
      if (final.success) {
        yield {
          type: 'log',
          level: 'info',
          message:
            `Agent's report (self-assessed ${final.data.selfAssessment.score}/5): ${final.data.summary}`.slice(
              0,
              2000,
            ),
        };
        for (const question of final.data.openQuestions.slice(0, 3))
          yield { type: 'log', level: 'warn', message: `Open question: ${question}`.slice(0, 2000) };
      } else yield { type: 'log', level: 'warn', message: 'The agent gave no readable final report.' };
      for (const name of collector.names().filter((name) => name.endsWith('.png'))) {
        const body = collector.get(name) as Buffer;
        const ref = `generation/${ctx.organizationId}/${ctx.jobId}/${ctx.attemptNo}/${createHash('sha256').update(body).digest('hex').slice(0, 16)}.png`;
        await this.deps.artifacts.put(ref, body, 'image/png');
        yield { type: 'artifact', kind: 'screenshot', ref };
      }
      const ref = await ctx.writeSpec(validation.spec);
      yield { type: 'file_change', path: 'site.json' };
      yield { type: 'artifact', kind: 'site_spec', ref };
      yield { type: 'progress', pct: 100, label: 'Done' };
      yield { type: 'done', siteSpecRef: ref };
    } catch (error) {
      if (signal.aborted) throw error;
      const failure =
        error instanceof RunFailure
          ? error.failure
          : {
              code: 'ENGINE_ERROR',
              message: `The ${this.id} engine failed: ${error instanceof Error ? error.message : String(error)}`,
              retryable: true,
            };
      yield redact({ type: 'error', ...failure, message: failure.message.slice(0, 1000) });
    }
  }
}
