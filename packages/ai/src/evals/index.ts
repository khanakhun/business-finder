// @bf/ai/evals — the eval harness (scorers, configs, runner). Used by `pnpm eval` and its tests.
export { defineEval, type EvalConfig } from './define-eval.ts';
export { EvalJudge } from './judge-task.ts';
export { type EvalReport, type RowResult, reportMarkdown, runEval } from './run-eval.ts';
export {
  type AggregateScorer,
  atPath,
  type EvalRow,
  exactMatch,
  jsonPathMatch,
  llmJudge,
  macroF1,
  meanAbsoluteError,
  numericTolerance,
  type ScoreContext,
  type Scorer,
  setF1,
} from './scorers.ts';
