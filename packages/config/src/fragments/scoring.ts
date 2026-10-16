import { z } from 'zod';

const cap = (defaultValue: number, what: string) =>
  z.coerce.number().int().min(1).max(10_000).default(defaultValue).describe(what);

/** Scoring limits (BF-032): every workspace profile is scored for every tracked business. */
export const scoringEnv = z.object({
  SCORING_MAX_WORKSPACE_PROFILES: cap(
    20,
    'Scoring profiles of its own a workspace may have unarchived (each is scored for every tracked business).',
  ),
  SCORING_MAX_PROFILE_VERSIONS: cap(200, 'Saved versions per workspace scoring profile.'),
});
