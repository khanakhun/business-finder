import { readFile } from 'node:fs/promises';
import { VISION_CRITERIA } from '@bf/contracts';
import { defineEval, jsonPathMatch } from '../../src/evals/index.ts';
import type { AggregateScorer } from '../../src/evals/scorers.ts';
import { WebsiteVisionGrade, type WebsiteVisionGradeOutput } from '../../src/tasks/website-vision-grade.ts';

interface Expected {
  readonly band: 'good' | 'average' | 'poor';
  readonly overall: { readonly min: number; readonly max: number };
}

const RANK: Readonly<Record<Expected['band'], number>> = { poor: 0, average: 1, good: 2 };

/** Over every pair of rows from different bands: the better band got the higher overall grade (ties count wrong). */
const pairwiseOrdering: AggregateScorer = {
  name: 'overall.pairwise',
  score(results) {
    const graded = results.map(({ row, output }) => ({
      rank: RANK[(row.expected as Expected).band],
      overall: (output as WebsiteVisionGradeOutput | undefined)?.overall,
    }));
    let pairs = 0;
    let right = 0;
    for (const [i, a] of graded.entries()) {
      for (const b of graded.slice(i + 1)) {
        if (a.rank === b.rank) continue;
        pairs += 1;
        const [better, worse] = a.rank > b.rank ? [a, b] : [b, a];
        if (better.overall !== undefined && worse.overall !== undefined && better.overall > worse.overall)
          right += 1;
      }
    }
    return pairs === 0 ? 1 : right / pairs;
  },
};

// BF-030 thresholds: ≥ 85% of overall grades within the expected band; ≥ 90% pairwise ordering (good > average >
// poor). Synthetic fixture sites only (sites/*.html rendered to screenshots/*.jpg): no third-party content.
export default defineEval({
  task: WebsiteVisionGrade,
  images: async (row) =>
    Promise.all(
      (row.input as { images: string[] }).images.map(async (path) => ({
        bytes: new Uint8Array(await readFile(new URL(path, import.meta.url))),
        mediaType: 'image/jpeg',
      })),
    ),
  scorers: [
    jsonPathMatch(
      'overall',
      (overall, row) => {
        const { min, max } = (row.expected as Expected).overall;
        return typeof overall === 'number' && overall >= min && overall <= max;
      },
      'within_band',
    ),
    jsonPathMatch(
      'criteria',
      (criteria) =>
        VISION_CRITERIA.every((id) => {
          const criterion = (criteria as Record<string, { score: number; evidence: string }> | undefined)?.[
            id
          ];
          return criterion !== undefined && criterion.evidence.trim().length > 0;
        }),
      'complete',
    ),
  ],
  aggregates: [pairwiseOrdering],
  thresholds: {
    'overall.within_band': 0.85,
    'criteria.complete': 1,
    'overall.pairwise': 0.9,
  },
});
