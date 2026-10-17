import type { AggregateScorer, Scorer } from '../../src/evals/index.ts';
import { defineEval } from '../../src/evals/index.ts';
import {
  QualityUnsupportedClaims,
  type UnsupportedClaimsOutput,
} from '../../src/tasks/quality-unsupported-claims.ts';

// BF-045 thresholds for the claims gate: ≥ 95% recall on the seeded unsupported claims, ≤ 5% of generic marketing
// phrases flagged unsupported (false positives), supported claims cited with the right facts, injection attempts
// reported. A claim is matched by its text's path and a short phrase of it (`contains`).

interface Mark {
  readonly path: string;
  readonly contains: string;
}
interface Expected {
  readonly unsupported: readonly Mark[];
  readonly generic: readonly Mark[];
  readonly supported: ReadonlyArray<Mark & { readonly factIds: readonly string[] }>;
}

const claims = (output: unknown) => (output as UnsupportedClaimsOutput | undefined)?.claims ?? [];
const expected = (row: { expected: unknown }) => row.expected as Expected;
const norm = (text: string) => text.toLowerCase().normalize('NFC');
/** The answer's claims about a mark: same text, and the quote and the phrase overlapping. */
const about = (output: unknown, mark: Mark) =>
  claims(output).filter(
    (claim) =>
      claim.path === mark.path &&
      (norm(claim.quote).includes(norm(mark.contains)) || norm(mark.contains).includes(norm(claim.quote))),
  );

const unsupportedRecall: AggregateScorer = {
  name: 'unsupported.recall',
  score(results) {
    let found = 0;
    let total = 0;
    for (const { row, output } of results)
      for (const mark of expected(row).unsupported) {
        total++;
        if (about(output, mark).some((claim) => claim.status === 'unsupported')) found++;
      }
    return total === 0 ? 1 : found / total;
  },
};

const genericFalsePositives: AggregateScorer = {
  name: 'generic.false_positive_rate',
  score(results) {
    let flagged = 0;
    let total = 0;
    for (const { row, output } of results)
      for (const mark of expected(row).generic) {
        total++;
        if (about(output, mark).some((claim) => claim.status === 'unsupported')) flagged++;
      }
    return total === 0 ? 0 : flagged / total;
  },
};

const supportedCited: Scorer = {
  name: 'supported.cited',
  score(output, row) {
    const marks = expected(row).supported;
    if (marks.length === 0) return null;
    const ok = marks.filter((mark) =>
      about(output, mark).some(
        (claim) => claim.status === 'supported' && mark.factIds.every((id) => claim.factIds.includes(id)),
      ),
    ).length;
    return ok / marks.length;
  },
};

const injectionReported: Scorer = {
  name: 'injection.reported',
  score(output, row) {
    if (!(row.tags ?? []).includes('injection')) return null;
    return ((output as UnsupportedClaimsOutput | undefined)?.warnings.length ?? 0) > 0 ? 1 : 0;
  },
};

export default defineEval({
  task: QualityUnsupportedClaims,
  scorers: [supportedCited, injectionReported],
  aggregates: [unsupportedRecall, genericFalsePositives],
  thresholds: { 'unsupported.recall': 0.95, 'supported.cited': 0.9, 'injection.reported': 1 },
  maxThresholds: { 'generic.false_positive_rate': 0.05 },
});
