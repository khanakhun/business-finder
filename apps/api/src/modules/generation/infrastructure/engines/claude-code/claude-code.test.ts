import { readFileSync } from 'node:fs';
import { EngineEventSchema } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import type { AgentRunPlan } from '../sandboxed/sandboxed-agent.engine.ts';
import { CLAUDE_CODE_ENV, claudeCodeArgv } from './argv.ts';
import { ClaudeStreamParser } from './claude-stream.parser.ts';

// Claude Code's argv (least privilege, asserted flag by flag) and its stream parser on golden fixtures
// (`__fixtures__/streams/claude-code`, synthesized from the 2.1.288 formats: see the README there).

const FIXTURES = new URL('../__fixtures__/streams/claude-code/', import.meta.url);
const PRICING = { 'claude-opus-5-5': { inputPerMTok: 5, outputPerMTok: 25, cachedInputPerMTok: 0.5 } };

function parse(name: string) {
  const parser = new ClaudeStreamParser(PRICING);
  const events = readFileSync(new URL(`${name}.jsonl`, FIXTURES), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => parser.line(line));
  return { parser, events };
}

const plan: AgentRunPlan = {
  task: 'Build the preview site of Salon Corail.',
  system: 'rules',
  reportSchema: { type: 'object', properties: { summary: { type: 'string' } } },
  model: 'claude-opus-5-5',
  maxTurns: 60,
  budgetUsd: 1.7,
  repair: false,
};

const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

describe('Claude Code argv', () => {
  it('never prompts, has no web or sub-agent tools, and pre-approves sitekit as its only command', () => {
    const argv = claudeCodeArgv(plan);
    expect(argv.slice(0, 3)).toEqual(['claude', '-p', plan.task]);
    expect(flag(argv, '--output-format')).toBe('stream-json');
    expect(argv).toContain('--verbose');
    expect(flag(argv, '--permission-mode')).toBe('dontAsk');
    expect(flag(argv, '--permission-prompts')).toBe('none');
    expect(flag(argv, '--tools')?.split(',')).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']);
    const allowed = flag(argv, '--allowedTools')?.split(',') ?? [];
    expect(allowed.filter((rule) => rule.startsWith('Bash'))).toEqual(['Bash(sitekit *)']);
    for (const tool of ['WebFetch', 'WebSearch', 'Task', 'Skill'])
      expect(flag(argv, '--disallowedTools')?.split(',')).toContain(tool);
    expect(argv.join(' ')).not.toMatch(/bypassPermissions|--dangerously|--bare/);
    expect(argv).toContain('--setting-sources=');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).toContain('--no-session-persistence');
    expect(flag(argv, '--append-system-prompt-file')).toBe('/workspace/.prompts/rules.md');
    expect(JSON.parse(flag(argv, '--json-schema') ?? '')).toEqual(plan.reportSchema);
    expect(flag(argv, '--model')).toBe('claude-opus-5-5');
    expect(flag(argv, '--max-turns')).toBe('60');
    expect(flag(argv, '--max-budget-usd')).toBe('1.70');
    // Argv only: every element fits the runner protocol (non-empty, ≤ 4096 characters, ≤ 64 of them).
    expect(argv.length).toBeLessThanOrEqual(64);
    for (const arg of argv) expect(arg.length).toBeGreaterThan(0);
  });

  it('with sitekit over MCP, has no shell at all', () => {
    const argv = claudeCodeArgv(plan, 'mcp');
    expect(flag(argv, '--tools')?.split(',')).not.toContain('Bash');
    expect(flag(argv, '--disallowedTools')?.split(',')).toContain('Bash');
    expect(flag(argv, '--allowedTools')?.split(',')).toContain('mcp__sitekit__*');
    expect(JSON.parse(flag(argv, '--mcp-config') ?? '')).toEqual({
      mcpServers: { sitekit: { command: 'sitekit', args: ['mcp'] } },
    });
  });

  it('turns telemetry, updates and memory off (no subprocess scrub: it needs bubblewrap)', () => {
    expect(CLAUDE_CODE_ENV).toMatchObject({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_AUTOUPDATER: '1',
    });
    expect(Object.keys(CLAUDE_CODE_ENV)).not.toContain('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB');
    expect(Object.keys(CLAUDE_CODE_ENV)).not.toContain('ANTHROPIC_API_KEY');
  });
});

describe('Claude Code stream parser (golden fixtures)', () => {
  it('maps a successful run to events, skipping unknown and malformed lines', async () => {
    const { parser, events } = parse('success');
    for (const event of events) expect(EngineEventSchema.safeParse(event).success).toBe(true);
    await expect(`${JSON.stringify(events, null, 2)}\n`).toMatchFileSnapshot(
      '../__fixtures__/streams/claude-code/success.events.json',
    );
    expect(events.filter((e) => e.type === 'tool_call').map((e) => e.type === 'tool_call' && e.tool)).toEqual(
      ['Read', 'Bash', 'Edit', 'Bash', 'Bash', 'Bash'],
    );
    // The Edit of site.json and the sitekit ops call changed the site; the denied curl did not.
    expect(events.filter((e) => e.type === 'file_change')).toHaveLength(2);
    expect(events.some((e) => e.type === 'log' && e.level === 'warn' && /Denied Bash/.test(e.message))).toBe(
      true,
    );
    expect(parser.outcome()).toEqual({ report: expect.objectContaining({ summary: expect.any(String) }) });
    expect(parser.costUsd()).toBe(0.62);
    expect(parser.tokens()).toEqual({ input: 28_200, output: 2_100 });
  });

  it('prices the tokens while no result has come (the worker’s budget check)', () => {
    const { parser } = parse('interrupted');
    // msg_01: 1200 in / 300 out; msg_02: 40 + 9000 cached in / 80 out.
    const expected = (1200 * 5 + 300 * 25 + 40 * 5 + 9000 * 0.5 + 80 * 25) / 1_000_000;
    expect(parser.costUsd()).toBeCloseTo(expected, 6);
    expect(parser.outcome().failure).toMatchObject({ code: 'ENGINE_INCOMPLETE', retryable: true });
    expect(new ClaudeStreamParser({}).costUsd()).toBeNull();
  });

  it('types each way a run can end', () => {
    expect(parse('max-turns').parser.outcome().failure).toMatchObject({
      code: 'ENGINE_INCOMPLETE',
      retryable: true,
    });
    expect(parse('budget-exceeded').parser.outcome().failure).toMatchObject({
      code: 'ENGINE_BUDGET_EXCEEDED',
      retryable: false,
    });
    expect(parse('api-error').parser.outcome().failure).toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable: true,
    });
    expect(parse('invalid-report').parser.outcome().failure).toMatchObject({
      code: 'ENGINE_INVALID_OUTPUT',
      retryable: true,
    });
  });

  it('handles 10k lines without buffering the stream', () => {
    const parser = new ClaudeStreamParser(PRICING);
    let count = 0;
    for (let i = 0; i < 10_000; i++)
      count += parser.line(
        JSON.stringify({
          type: 'assistant',
          message: {
            id: `msg_${i}`,
            model: 'claude-opus-5-5',
            content: [
              { type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: '/workspace/brief.json' } },
            ],
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        }),
      ).length;
    expect(count).toBe(10_000);
    expect(parser.tokens()).toEqual({ input: 100_000, output: 10_000 });
  });
});
