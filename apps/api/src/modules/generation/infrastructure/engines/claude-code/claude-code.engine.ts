import type { ModelPricing } from '@bf/ai';
import type { EngineCapabilities } from '@bf/contracts';
import {
  type AgentRunPlan,
  SandboxedAgentEngine,
  type SandboxedEngineDeps,
} from '../sandboxed/sandboxed-agent.engine.ts';
import { CLAUDE_CODE_ENV, claudeCodeArgv, type SitekitAccess } from './argv.ts';
import { ClaudeStreamParser } from './claude-stream.parser.ts';

// The Claude Code engine (BF-044): `claude -p` in a sandbox, sitekit as its only shell command.

export const CLAUDE_CODE_CAPABILITIES: EngineCapabilities = {
  sandboxed: true,
  supportsRepair: true,
  supportsChatEdit: false,
  maxParallel: 4,
  // DECISION(BF-044): estimates until the benchmark measures them (it needs model keys; QUESTIONS.md).
  typicalCostUsd: 1.5,
  typicalDurationSec: 600,
};

export class ClaudeCodeEngine extends SandboxedAgentEngine {
  readonly id = 'claude-code' as const;
  readonly capabilities = CLAUDE_CODE_CAPABILITIES;
  protected readonly keyEnv = 'ANTHROPIC_API_KEY';
  protected readonly versionKey = 'claude';
  /** The CLI versions its argv and stream format were verified on. */
  protected readonly versionRange = { min: '2.1.288', below: '2.2.0' };

  constructor(
    deps: SandboxedEngineDeps,
    private readonly options: { readonly pricing: ModelPricing; readonly sitekit?: SitekitAccess },
  ) {
    super(deps);
  }

  protected command(plan: AgentRunPlan): string[] {
    return claudeCodeArgv(plan, this.options.sitekit ?? 'bash');
  }

  protected env(): Record<string, string> {
    return { ...CLAUDE_CODE_ENV };
  }

  protected parser() {
    return new ClaudeStreamParser(this.options.pricing);
  }
}
