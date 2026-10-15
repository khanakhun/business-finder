import { defineEval, jsonPathMatch } from '../../src/evals/index.ts';
import { TaxonomyClassifyBusiness } from '../../src/tasks/taxonomy-classify-business.ts';

interface Expected {
  readonly primary: string;
  readonly acceptable: readonly string[];
}

// Primary category accuracy ≥ 0.9 (BF-015). Ambiguous rows accept several answers; answering outside the candidate
// list is never acceptable (the classifier would discard it anyway).
export default defineEval({
  task: TaxonomyClassifyBusiness,
  scorers: [
    jsonPathMatch(
      'primary',
      (primary, row) => (row.expected as Expected).acceptable.includes(String(primary)),
      'accurate',
    ),
    jsonPathMatch(
      'primary',
      (primary, row) =>
        primary === 'none' ||
        (row.input as { candidates: Array<{ id: string }> }).candidates.some((c) => c.id === primary),
      'valid_id',
    ),
  ],
  thresholds: {
    'primary.accurate': 0.9,
    'primary.valid_id': 1,
  },
});
