import { defineEval, exactMatch, type Scorer, setF1 } from '../../src/evals/index.ts';
import { SearchParseIntent } from '../../src/tasks/search-parse-intent.ts';

interface Expected {
  readonly categoryIds: readonly string[];
  readonly filters: Readonly<Record<string, unknown>>;
  readonly clarify: boolean;
}

/** The filters that differ from "anything" (website any, null, []), arrays sorted, for exact comparison. */
export function activeFilters(filters: unknown): Record<string, unknown> {
  const active: Record<string, unknown> = {};
  for (const [key, value] of Object.entries((filters ?? {}) as Record<string, unknown>)) {
    if (value === null || value === undefined || value === 'any') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) active[key] = [...value].map(String).sort();
      continue;
    }
    active[key] = value;
  }
  return active;
}

const canonical = (value: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));

const filtersExact: Scorer = {
  name: 'filters.exact',
  score: (output, row) =>
    canonical(activeFilters((output as { filters?: unknown }).filters)) ===
    canonical(activeFilters((row.expected as Expected).filters))
      ? 1
      : 0,
};

/** Of the rows where the model asked a question, the share that deserved one (rows without a question: n/a). */
const clarificationPrecision: Scorer = {
  name: 'needsClarification.precision',
  score: (output, row) =>
    (output as { needsClarification?: unknown }).needsClarification
      ? (row.expected as Expected).clarify
        ? 1
        : 0
      : null,
};

/** Of the rows that deserved a question, the share where the model asked one (other rows: n/a). */
const clarificationRecall: Scorer = {
  name: 'needsClarification.recall',
  score: (output, row) =>
    (row.expected as Expected).clarify
      ? (output as { needsClarification?: unknown }).needsClarification
        ? 1
        : 0
      : null,
};

const validIds: Scorer = {
  name: 'categoryIds.valid',
  score: (output, row) => {
    const allowed = new Set((row.input as { candidates: Array<{ id: string }> }).candidates.map((c) => c.id));
    return ((output as { categoryIds?: string[] }).categoryIds ?? []).every((id) => allowed.has(id)) ? 1 : 0;
  },
};

// BF-021 thresholds: category F1 ≥ 0.90, location text exact ≥ 0.95, filters exact ≥ 0.90, mode ≥ 0.95,
// clarification precision ≥ 0.8; ids outside the candidates are never acceptable.
// DECISION(BF-021): recall ≥ 0.8 too, so a model that never asks cannot pass precision vacuously.
export default defineEval({
  task: SearchParseIntent,
  scorers: [
    setF1('categoryIds'),
    exactMatch('locationText'),
    filtersExact,
    exactMatch('mode'),
    clarificationPrecision,
    clarificationRecall,
    validIds,
  ],
  thresholds: {
    'categoryIds.f1': 0.9,
    'locationText.exact': 0.95,
    'filters.exact': 0.9,
    'mode.exact': 0.95,
    'needsClarification.precision': 0.8,
    'needsClarification.recall': 0.8,
    'categoryIds.valid': 1,
  },
});
