import type { GenerationEngineListing } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { assignEngines, defaultParallel, estimate, parsePattern } from './engines.ts';

const listing: GenerationEngineListing = {
  items: [
    {
      id: 'blocks',
      available: true,
      queued: 0,
      running: 0,
      capabilities: {
        sandboxed: false,
        supportsRepair: true,
        supportsChatEdit: true,
        maxParallel: 8,
        typicalCostUsd: 0.12,
        typicalDurationSec: 45,
      },
    },
    {
      id: 'claude-code',
      available: true,
      queued: 3,
      running: 2,
      capabilities: {
        sandboxed: true,
        supportsRepair: true,
        supportsChatEdit: false,
        maxParallel: 4,
        typicalCostUsd: 1.5,
        typicalDurationSec: 600,
      },
    },
    {
      id: 'codex',
      available: false,
      queued: 0,
      running: 0,
      capabilities: {
        sandboxed: true,
        supportsRepair: true,
        supportsChatEdit: false,
        maxParallel: 4,
        typicalCostUsd: 1.5,
        typicalDurationSec: 600,
      },
    },
  ],
};

describe('engine assignment', () => {
  it('reads patterns in several spellings', () => {
    expect(parsePattern('2 Claude Code + 2 Codex + rest Blocks')).toEqual([
      { count: 2, engine: 'claude-code' },
      { count: 2, engine: 'codex' },
      { count: null, engine: 'blocks' },
    ]);
    expect(parsePattern('2 × claude, 1 sdk, reste blocks')).toEqual([
      { count: 2, engine: 'claude-code' },
      { count: 1, engine: 'claude-agent-sdk' },
      { count: null, engine: 'blocks' },
    ]);
    expect(parsePattern('two codex')).toBeNull();
    expect(parsePattern('2 gemini')).toBeNull();
    expect(parsePattern('')).toBeNull();
  });

  it('assigns by position: 2 Claude Code + 2 Codex + rest Blocks over 6 items', () => {
    const pattern = parsePattern('2 claude-code + 2 codex + rest blocks') ?? [];
    expect(assignEngines(6, pattern)).toEqual([
      'claude-code',
      'claude-code',
      'codex',
      'codex',
      'blocks',
      'blocks',
    ]);
    expect(assignEngines(3, pattern)).toEqual(['claude-code', 'claude-code', 'codex']);
    expect(assignEngines(3, parsePattern('1 codex') ?? [])).toEqual(['codex', 'auto', 'auto']);
  });
});

describe('estimate', () => {
  it('sums typical costs (auto = the cheapest available) and lays durations on the parallel lanes', () => {
    expect(estimate(['claude-code', 'blocks', 'auto'], listing, 1)).toEqual({ costUsd: 1.74, etaSec: 690 });
    expect(estimate(['claude-code', 'blocks', 'auto'], listing, 3)).toEqual({ costUsd: 1.74, etaSec: 600 });
    expect(estimate([], listing, 2)).toEqual({ costUsd: 0, etaSec: 0 });
  });

  it('defaults parallel runs to the engines’ slots, at most the items', () => {
    expect(defaultParallel(['claude-code', 'claude-code', 'codex'], listing)).toBe(3);
    expect(defaultParallel(['blocks'], listing)).toBe(1);
  });
});
