import { describe, expect, it } from 'vitest';
import { stepsOf } from './status-stepper.ts';

const view = (status: Parameters<typeof stepsOf>[0], attempts = 1) =>
  stepsOf(status, attempts).map((step) => `${step.id}:${step.state}`);

describe('status stepper', () => {
  it('walks a job from queued to its outcome', () => {
    expect(view('queued')).toEqual([
      'queued:current',
      'preparing:todo',
      'running:todo',
      'validating:todo',
      'result:todo',
    ]);
    expect(view('running')).toEqual([
      'queued:done',
      'preparing:done',
      'running:current',
      'validating:todo',
      'result:todo',
    ]);
    expect(view('succeeded')).toEqual([
      'queued:done',
      'preparing:done',
      'running:done',
      'validating:done',
      'succeeded:done',
    ]);
  });

  it('shows repairing when it happened', () => {
    expect(view('repairing', 2)).toContain('repairing:current');
    expect(view('needs_review', 3)).toEqual([
      'queued:done',
      'preparing:done',
      'running:done',
      'validating:done',
      'repairing:done',
      'needs_review:done',
    ]);
    expect(view('validating', 2)).toEqual([
      'queued:done',
      'preparing:done',
      'running:done',
      'validating:current',
      'repairing:todo',
      'result:todo',
    ]);
  });
});
