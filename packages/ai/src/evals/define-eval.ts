import type { ObjectTask, TextTask, VisionTask } from '../define-task.ts';
import type { AiImage } from '../vision.ts';
import type { AggregateScorer, EvalRow, Scorer } from './scorers.ts';

/** `evals/<task>/eval.config.ts` default export: the task, its scorers and the minimum mean score per scorer. */
export interface EvalConfig {
  readonly task: ObjectTask | TextTask | VisionTask;
  /**
   * Vision tasks: the row's images (its `input` is then `{ input, images }`, images being paths the config
   * resolves, e.g. relative to the dataset).
   */
  readonly images?: (row: EvalRow) => Promise<AiImage[]>;
  readonly scorers: readonly Scorer[];
  /** Dataset-level metrics (macro-F1, mean absolute error…) computed over every row at once. */
  readonly aggregates?: readonly AggregateScorer[];
  /** Scorer name → minimum mean over the dataset; the run fails below it. */
  readonly thresholds: Readonly<Record<string, number>>;
  /** Scorer name → maximum (for lower-is-better metrics such as an error); the run fails above it. */
  readonly maxThresholds?: Readonly<Record<string, number>>;
}

export function defineEval(config: EvalConfig): EvalConfig {
  const names = new Set([...config.scorers, ...(config.aggregates ?? [])].map((s) => s.name));
  for (const name of [...Object.keys(config.thresholds), ...Object.keys(config.maxThresholds ?? {})]) {
    if (!names.has(name))
      throw new Error(`Threshold for unknown scorer "${name}" (have: ${[...names].join(', ')})`);
  }
  return config;
}
