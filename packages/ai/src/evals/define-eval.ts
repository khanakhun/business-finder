import type { ObjectTask, TextTask } from '../define-task.ts';
import type { Scorer } from './scorers.ts';

/** `evals/<task>/eval.config.ts` default export: the task, its scorers and the minimum mean score per scorer. */
export interface EvalConfig {
  readonly task: ObjectTask | TextTask;
  readonly scorers: readonly Scorer[];
  /** Scorer name → minimum mean over the dataset; the run fails below it. */
  readonly thresholds: Readonly<Record<string, number>>;
}

export function defineEval(config: EvalConfig): EvalConfig {
  const names = new Set(config.scorers.map((s) => s.name));
  for (const name of Object.keys(config.thresholds)) {
    if (!names.has(name))
      throw new Error(`Threshold for unknown scorer "${name}" (have: ${[...names].join(', ')})`);
  }
  return config;
}
