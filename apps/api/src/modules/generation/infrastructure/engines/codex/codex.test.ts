import { readFileSync } from 'node:fs';
import type { ModelPricing } from '@bf/ai';
import { EngineEventSchema } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import type { AgentRunPlan } from '../sandboxed/sandboxed-agent.engine.ts';
import { codexArgv } from './argv.ts';
import { CodexStreamParser } from './codex-stream.parser.ts';

// Codex's argv (asserted flag by flag) and its event parser on golden fixtures (`__fixtures__/streams/codex`,
// synthesized from the 0.160.0 event types: see the README there), with the cost computed from its tokens.

const FIXTURES = new URL('../__fixtures__/streams/codex/', import.meta.url);
const MODEL = 'gpt-6.1-sol';
const PRICING = { [MODEL]: { inputPerMTok: 2, outputPerMTok: 12, cachedInputPerMTok: 0.2 } };

function parse(name: string, pricing: ModelPricing = PRICING) {
  const parser = new CodexStreamParser(pricing, MODEL);
  const events = readFileSync(new URL(`${name}.jsonl`, FIXTURES), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => parser.line(line));
  return { parser, events };
}

const plan: AgentRunPlan = {
  task: 'Build the preview site of Café Bleu.',
  system: 'rules',
  reportSchema: {},
  model: MODEL,
  maxTurns: 60,
  budgetUsd: 3.4,
  repair: false,
};
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

describe('Codex argv', () => {
  it('runs exec with JSON events, the report schema, no web search, history or analytics, and a minimal shell env', () => {
    const argv = codexArgv(plan, { reasoningEffort: 'high' });
    expect(argv.slice(0, 3)).toEqual(['codex', 'exec', plan.task]);
    expect(argv).toContain('--json');
    expect(argv).toContain('--skip-git-repo-check');
    expect(argv).toContain('--ephemeral');
    expect(flag(argv, '--output-schema')).toBe('/workspace/.prompts/final-report.schema.json');
    expect(flag(argv, '-o')).toBe('/workspace/.sitekit/final-report.json');
    expect(flag(argv, '-m')).toBe(MODEL);
    const config = argv.filter((_, index) => argv[index - 1] === '-c');
    expect(config).toEqual(
      expect.arrayContaining([
        'model_reasoning_effort="high"',
        'analytics.enabled=false',
        'check_for_update_on_startup=false',
        'history.persistence="none"',
        'web_search="disabled"',
        'shell_environment_policy.inherit="core"',
      ]),
    );
    // Codex's own sandbox cannot run inside ours (ADR-0010 addendum): the container is the sandbox.
    expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(argv).not.toContain('--full-auto');
    expect(argv.length).toBeLessThanOrEqual(64);
    for (const arg of argv) expect(arg.length).toBeGreaterThan(0);
  });
});

describe('Codex stream parser (golden fixtures)', () => {
  it('maps a successful run to events and prices its tokens', async () => {
    const { parser, events } = parse('success');
    for (const event of events) expect(EngineEventSchema.safeParse(event).success).toBe(true);
    await expect(`${JSON.stringify(events, null, 2)}\n`).toMatchFileSnapshot(
      '../__fixtures__/streams/codex/success.events.json',
    );
    // One tool call per command or MCP item, even when an item starts and completes.
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(4);
    expect(events.filter((e) => e.type === 'file_change')).toEqual([
      { type: 'file_change', path: 'site.json' },
    ]);
    // The reconnect and the failed curl are warnings, not failures.
    expect(events.filter((e) => e.type === 'log' && e.level === 'warn')).toHaveLength(2);
    expect(parser.outcome()).toEqual({ report: expect.objectContaining({ pagesBuilt: ['/', '/menu'] }) });
    expect(parser.tokens()).toEqual({ input: 184_000, output: 9_200 });
    const expected = (34_000 * 2 + 150_000 * 0.2 + 9_200 * 12) / 1_000_000;
    expect(parser.costUsd()).toBeCloseTo(expected, 6);
  });

  it('types a failed or unfinished turn, and keeps an unreadable report as none', () => {
    expect(parse('turn-failed').parser.outcome().failure).toMatchObject({
      code: 'ENGINE_INCOMPLETE',
      retryable: true,
    });
    expect(parse('interrupted').parser.outcome().failure).toMatchObject({ code: 'ENGINE_INCOMPLETE' });
    expect(parse('no-report').parser.outcome()).toEqual({ report: undefined });
  });

  it('costs nothing before the turn ends, and is unpriced without a price', () => {
    expect(parse('interrupted').parser.costUsd()).toBe(0);
    expect(parse('success', {}).parser.costUsd()).toBeNull();
  });
});
