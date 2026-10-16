import { z } from 'zod';

/** Listing search (BF-022): hybrid ranking knobs. Measure (`pnpm --filter @bf/api bench:search`) before changing. */
export const searchEnv = z.object({
  SEARCH_VECTOR_MAX_DISTANCE: z.coerce
    .number()
    .gt(0)
    .max(2)
    .default(0.7)
    .describe(
      'Cosine distance above which a semantic match is dropped, so unrelated text does not return the nearest 200.',
    ),
  SEARCH_HNSW_EF_SEARCH: z.coerce
    .number()
    .int()
    .min(10)
    .max(1_000)
    .default(100)
    .describe('pgvector hnsw.ef_search for semantic ranking (recall vs latency).'),
  SEARCH_EXPORT_MAX_ROWS: z.coerce
    .number()
    .int()
    .min(1)
    .max(50_000)
    .default(50_000)
    .describe('Rows one CSV export may stream.'),
});
