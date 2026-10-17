import { describe, expect, it } from 'vitest';
import type { AgentRunPlan } from '../sandboxed/sandboxed-agent.engine.ts';
import { agentSdkArgv, CLAUDE_AGENT_SDK_CAPABILITIES } from './claude-agent-sdk.engine.ts';

// The Agent SDK engine's command (BF-044): the bundled runner with the task, our rules and report schema in the
// workspace, the model, the turns and the agent's budget — the policy itself is the runner's (agent-sdk-runner.ts).

const plan: AgentRunPlan = {
  task: 'Build the preview site of Salon Corail.',
  system: 'rules',
  reportSchema: {},
  model: 'claude-opus-5-5',
  maxTurns: 40,
  budgetUsd: 2.55,
  repair: true,
};

describe('Claude Agent SDK argv', () => {
  it('runs the bundled runner on the workspace’s rules and schema with the plan’s limits', () => {
    expect(agentSdkArgv(plan)).toEqual([
      'node',
      '/opt/runner/agent-sdk-runner.mjs',
      '--task',
      plan.task,
      '--rules',
      '/workspace/.prompts/rules.md',
      '--schema',
      '/workspace/.prompts/final-report.schema.json',
      '--model',
      'claude-opus-5-5',
      '--max-turns',
      '40',
      '--max-budget-usd',
      '2.55',
    ]);
    expect(CLAUDE_AGENT_SDK_CAPABILITIES).toMatchObject({ sandboxed: true, supportsRepair: true });
  });
});
