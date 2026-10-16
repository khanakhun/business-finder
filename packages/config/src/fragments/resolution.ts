import { z } from 'zod';

const probability = (defaultValue: number) => z.coerce.number().min(0).max(1).default(defaultValue);

/** Entity resolution thresholds (BF-016): when a source record is the same business as a golden record. */
export const resolutionEnv = z.object({
  RESOLUTION_MATCH_THRESHOLD: probability(0.85).describe(
    'Match score at or above which a source record is merged into an existing business.',
  ),
  RESOLUTION_POSSIBLE_THRESHOLD: probability(0.6).describe(
    'Match score at or above which (below the match threshold) a new business is flagged as a possible duplicate.',
  ),
});
