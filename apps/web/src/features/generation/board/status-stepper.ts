import type { GenerationJobStatus } from '@bf/contracts';

// The steps a job shows (BF-046): the way to a result, and where it is on it. Repairing appears only when it
// happened; the last step is the outcome once there is one.

export const STEPS = ['queued', 'preparing', 'running', 'validating'] as const;
export type StepState = 'done' | 'current' | 'todo';
export const TERMINAL: ReadonlySet<GenerationJobStatus> = new Set([
  'succeeded',
  'needs_review',
  'failed',
  'cancelled',
]);

export interface Step {
  readonly id: GenerationJobStatus | 'result';
  readonly state: StepState;
}

/** The stepper of a job in `status` (`attempts` > 1 means a repair happened). */
export function stepsOf(status: GenerationJobStatus, attempts: number): Step[] {
  const flow: (GenerationJobStatus | 'result')[] = [...STEPS];
  if (status === 'repairing' || attempts > 1) flow.push('repairing');
  flow.push(TERMINAL.has(status) ? status : 'result');
  const at = TERMINAL.has(status) ? flow.length - 1 : flow.indexOf(status);
  return flow.map((id, index) => ({
    id,
    state: index < at ? 'done' : index === at ? (TERMINAL.has(status) ? 'done' : 'current') : 'todo',
  }));
}
