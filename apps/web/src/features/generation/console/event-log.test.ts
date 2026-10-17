import { describe, expect, it } from 'vitest';
import { type LoggedEvent, matches, merge, rowsOf, usageOf } from './event-log.ts';

const at = '2026-10-17T08:00:00.000Z';
const log = (seq: number, message: string, attempt: number | null = 1): LoggedEvent => ({
  seq,
  type: 'log',
  level: 'info',
  message,
  attempt,
  at,
});

describe('event log', () => {
  it('keeps each event once, in order, across replays and reconnects', () => {
    let state = merge([], 0, [log(1, 'a'), log(2, 'b')]);
    // The browser reconnects with Last-Event-ID 1 and gets 2 again, then 3; a stray older one is ignored.
    state = merge(state.log, state.lastSeq, [log(2, 'b'), log(3, 'c'), log(1, 'a')]);
    // Out of order in one batch.
    state = merge(state.log, state.lastSeq, [log(5, 'e'), log(4, 'd')]);
    expect(state.log.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(state.lastSeq).toBe(5);
  });

  it('filters by kind and searches the text', () => {
    const tool: LoggedEvent = {
      seq: 1,
      type: 'tool_call',
      tool: 'Edit',
      summary: 'site.json',
      attempt: 1,
      at,
    };
    const warn: LoggedEvent = {
      seq: 2,
      type: 'log',
      level: 'warn',
      message: 'Quality repair',
      attempt: 1,
      at,
    };
    const beat: LoggedEvent = { seq: 3, type: 'heartbeat', attempt: 1, at };
    expect(matches(tool, 'tools', '')).toBe(true);
    expect(matches(tool, 'logs', '')).toBe(false);
    expect(matches(warn, 'errors', '')).toBe(true);
    expect(matches(warn, 'all', 'REPAIR')).toBe(true);
    expect(matches(warn, 'all', 'nothing')).toBe(false);
    expect(matches(beat, 'all', '')).toBe(false);
  });

  it('groups rows by attempt', () => {
    const rows = rowsOf([log(1, 'a', 1), log(2, 'b', 1), log(3, 'c', 2), log(4, 'review', null)], 'all', '');
    expect(rows.map((row) => (row.kind === 'attempt' ? `#${row.attempt}` : row.event.seq))).toEqual([
      '#1',
      1,
      2,
      '#2',
      3,
      '#null',
      4,
    ]);
  });

  it('adds up usage', () => {
    expect(
      usageOf([
        { seq: 1, type: 'usage', inputTokens: 100, outputTokens: 50, costUsd: 0.01, attempt: 1, at },
        { seq: 2, type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.002, attempt: 2, at },
      ]),
    ).toEqual({ costUsd: 0.012, tokens: 165 });
  });
});
