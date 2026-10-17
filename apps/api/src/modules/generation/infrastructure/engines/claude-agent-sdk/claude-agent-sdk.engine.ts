import type { ModelPricing } from '@bf/ai';
import type { EngineCapabilities } from '@bf/contracts';
import { CLAUDE_CODE_ENV, WORKSPACE_DIR } from '../claude-code/argv.ts';
import { ClaudeStreamParser } from '../claude-code/claude-stream.parser.ts';
import { AGENT_PATHS } from '../sandboxed/agent-workspace.ts';
import {
  type AgentRunPlan,
  SandboxedAgentEngine,
  type SandboxedEngineDeps,
} from '../sandboxed/sandboxed-agent.engine.ts';

// The Claude Agent SDK engine (BF-044): `query()` inside the sandbox (services/agent-runner/src/agent-sdk-runner.ts,
// SDK 0.3.288 on the image's Claude Code 2.1.288), with file tools and sitekit's MCP server, no shell and no web, and
// a hook refusing paths outside the workspace. It prints the SDK's messages — Claude Code's stream format — so the
// engine shares Claude Code's parser.

export const AGENT_SDK_RUNNER = '/opt/runner/agent-sdk-runner.mjs';

export const CLAUDE_AGENT_SDK_CAPABILITIES: EngineCapabilities = {
  sandboxed: true,
  supportsRepair: true,
  supportsChatEdit: false,
  maxParallel: 4,
  // DECISION(BF-044): estimates until the benchmark measures them (it needs model keys; QUESTIONS.md).
  typicalCostUsd: 1.2,
  typicalDurationSec: 540,
};

export function agentSdkArgv(plan: AgentRunPlan): string[] {
  return [
    'node',
    AGENT_SDK_RUNNER,
    '--task',
    plan.task,
    '--rules',
    `${WORKSPACE_DIR}/${AGENT_PATHS.rules}`,
    '--schema',
    `${WORKSPACE_DIR}/${AGENT_PATHS.schema}`,
    '--model',
    plan.model,
    '--max-turns',
    String(plan.maxTurns),
    '--max-budget-usd',
    plan.budgetUsd.toFixed(2),
  ];
}

export class ClaudeAgentSdkEngine extends SandboxedAgentEngine {
  readonly id = 'claude-agent-sdk' as const;
  readonly capabilities = CLAUDE_AGENT_SDK_CAPABILITIES;
  protected readonly keyEnv = 'ANTHROPIC_API_KEY';
  /** The CLI the SDK drives is the image's Claude Code: the same range as the claude-code engine. */
  protected readonly versionKey = 'claude';
  protected readonly versionRange = { min: '2.1.288', below: '2.2.0' };

  constructor(
    deps: SandboxedEngineDeps,
    private readonly options: { readonly pricing: ModelPricing },
  ) {
    super(deps);
  }

  protected command(plan: AgentRunPlan): string[] {
    return agentSdkArgv(plan);
  }

  protected env(): Record<string, string> {
    return { ...CLAUDE_CODE_ENV };
  }

  protected parser() {
    return new ClaudeStreamParser(this.options.pricing);
  }
}
