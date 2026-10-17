import {
  InvalidStateTransitionError,
  PIPELINE_STATUSES,
  type PipelineStatus,
  ValidationError,
} from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { allowedTransitions, checkTransition, TRANSITIONS } from './pipeline.ts';

// Every (from, to, trigger) pair against the expected table: a change to the machine must change this test.
const MANUAL: Record<PipelineStatus, PipelineStatus[]> = {
  new: ['qualified', 'disqualified'],
  qualified: ['contacted', 'disqualified'],
  contacted: ['engaged', 'lost'],
  engaged: ['meeting', 'lost'],
  meeting: ['proposal', 'lost'],
  proposal: ['won', 'lost'],
  won: [],
  lost: ['qualified'],
  disqualified: ['new'],
};
const AUTOMATIC: Record<PipelineStatus, PipelineStatus[]> = {
  // BF-052: a first contact qualifies a business still `new` (auto-qualify on contact).
  new: ['qualified', 'engaged'],
  qualified: ['contacted', 'engaged'],
  contacted: ['engaged'],
  engaged: [],
  meeting: [],
  proposal: [],
  won: [],
  lost: [],
  disqualified: [],
};

describe('pipeline state machine', () => {
  for (const from of PIPELINE_STATUSES) {
    for (const to of PIPELINE_STATUSES) {
      for (const [trigger, table] of [
        ['manual', MANUAL],
        ['automatic', AUTOMATIC],
      ] as const) {
        const allowed = table[from].includes(to);
        it(`${trigger}: ${from} → ${to} is ${allowed ? 'allowed' : 'refused'}`, () => {
          const attempt = () => checkTransition(from, to, 'because', trigger);
          if (allowed) expect(attempt).not.toThrow();
          else expect(attempt).toThrow(InvalidStateTransitionError);
        });
      }
    }
  }

  it('lists the allowed moves with the reasons they need', () => {
    expect(allowedTransitions('proposal')).toEqual([
      { to: 'won', requiresReason: false },
      { to: 'lost', requiresReason: true },
    ]);
    expect(allowedTransitions('won')).toEqual([]);
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...PIPELINE_STATUSES].sort());
  });

  it('requires a reason for lost and disqualified, and trims it', () => {
    expect(() => checkTransition('new', 'disqualified', undefined, 'manual')).toThrow(ValidationError);
    expect(() => checkTransition('engaged', 'lost', '   ', 'manual')).toThrow(ValidationError);
    expect(checkTransition('engaged', 'lost', '  budget  ', 'manual')).toBe('budget');
    expect(checkTransition('new', 'qualified', 'ignored', 'manual')).toBeNull();
  });
});
