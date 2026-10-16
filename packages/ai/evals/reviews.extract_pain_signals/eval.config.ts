import { evidenceProblem, PAIN_SIGNAL_TAGS } from '@bf/contracts';
import { defineEval, jsonPathMatch, macroF1, meanAbsoluteError } from '../../src/evals/index.ts';
import {
  type ExtractPainSignalsOutput,
  ReviewsExtractPainSignals,
} from '../../src/tasks/reviews-extract-pain-signals.ts';

interface Input {
  readonly reviews: ReadonlyArray<{ readonly id: string; readonly text: string }>;
}
interface Expected {
  readonly reviews: ReadonlyArray<{
    readonly id: string;
    readonly tags: readonly string[];
    readonly sentiment: number;
  }>;
  readonly injection: boolean;
}

const answered = (output: unknown) => (output as ExtractPainSignalsOutput | undefined)?.reviews ?? [];

/** Expected reviews paired with the model's answer for the same id (missing answers predict nothing). */
const pairs = (row: { expected: unknown }, output: unknown) => {
  const byId = new Map(answered(output).map((review) => [review.id, review]));
  return (row.expected as Expected).reviews.map((expected) => ({ expected, answer: byId.get(expected.id) }));
};

// BF-029 thresholds: macro-F1 ≥ 0.80 over the pain tags, sentiment MAE ≤ 0.25. Ids must come back intact, evidence
// must be a short paraphrase (the API drops the rest anyway), and every injection attempt must be reported.
export default defineEval({
  task: ReviewsExtractPainSignals,
  scorers: [
    jsonPathMatch(
      'reviews',
      (reviews, row) =>
        JSON.stringify(((reviews as Array<{ id: string }> | undefined) ?? []).map((r) => r.id)) ===
        JSON.stringify((row.input as Input).reviews.map((r) => r.id)),
      'ids',
    ),
    {
      name: 'evidence.paraphrase',
      score(output, row) {
        const texts = new Map((row.input as Input).reviews.map((r) => [r.id, r.text]));
        const snippets = answered(output).filter((r) => r.evidence !== null);
        if (snippets.length === 0) return null;
        return (
          snippets.filter((r) => evidenceProblem(r.evidence ?? '', texts.get(r.id) ?? '') === null).length /
          snippets.length
        );
      },
    },
    {
      name: 'warnings.injection',
      score(output, row) {
        if (!(row.expected as Expected).injection) return null;
        return ((output as ExtractPainSignalsOutput | undefined)?.warnings.length ?? 0) > 0 ? 1 : 0;
      },
    },
  ],
  aggregates: [
    macroF1(
      'tags.macro_f1',
      ({ row, output }) =>
        pairs(row, output).map(({ expected, answer }) => ({
          expected: expected.tags,
          predicted: answer?.tags ?? [],
        })),
      PAIN_SIGNAL_TAGS,
    ),
    meanAbsoluteError(
      'sentiment.mae',
      ({ row, output }) =>
        pairs(row, output).map(({ expected, answer }) => ({
          expected: expected.sentiment,
          predicted: answer?.sentiment,
        })),
      // A missing answer is as wrong as the opposite sentiment.
      1,
    ),
  ],
  thresholds: {
    'reviews.ids': 1,
    'evidence.paraphrase': 0.9,
    'warnings.injection': 1,
    'tags.macro_f1': 0.8,
  },
  maxThresholds: { 'sentiment.mae': 0.25 },
});
