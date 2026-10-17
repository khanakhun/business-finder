import type { ModelPricing } from '@bf/ai';
import type { EngineCapabilities } from '@bf/contracts';
import {
  type AgentRunPlan,
  SandboxedAgentEngine,
  type SandboxedEngineDeps,
} from '../sandboxed/sandboxed-agent.engine.ts';
import { type CodexOptions, codexArgv } from './argv.ts';
import { CodexStreamParser } from './codex-stream.parser.ts';

// The Codex engine (BF-044): `codex exec` in a sandbox. Codex reports no USD: its tokens are priced with the
// configured table, and its usage arrives at the end of the turn only — within a run, wall time bounds it.

export const CODEX_CAPABILITIES: EngineCapabilities = {
  sandboxed: true,
  supportsRepair: true,
  supportsChatEdit: false,
  maxParallel: 4,
  // DECISION(BF-044): estimates until the benchmark measures them (it needs model keys; QUESTIONS.md).
  typicalCostUsd: 1.5,
  typicalDurationSec: 600,
};

export class CodexEngine extends SandboxedAgentEngine {
  readonly id = 'codex' as const;
  readonly capabilities = CODEX_CAPABILITIES;
  protected readonly keyEnv = 'CODEX_API_KEY';
  protected readonly versionKey = 'codex';
  /** The CLI versions its argv and event schema were verified on. */
  protected readonly versionRange = { min: '0.160.0', below: '0.161.0' };

  constructor(
    deps: SandboxedEngineDeps,
    private readonly options: { readonly pricing: ModelPricing } & CodexOptions,
  ) {
    super(deps);
  }

  protected command(plan: AgentRunPlan): string[] {
    return codexArgv(plan, { reasoningEffort: this.options.reasoningEffort });
  }

  protected env(): Record<string, string> {
    // HOME is the sandbox's tmpfs, seeded with a config that turns update checks off (BF-043).
    return { NO_COLOR: '1' };
  }

  protected parser() {
    return new CodexStreamParser(this.options.pricing, this.deps.settings.model);
  }
}
