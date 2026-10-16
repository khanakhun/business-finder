import { z } from 'zod';
import { FactIdSchema } from './spec/localized.ts';
import { SiteSpecSchema } from './spec/site.ts';

/**
 * What a generation engine returns (BF-033): the site, a short summary for the operator, and the facts the copy
 * relies on (checked against the fact registry). The reduced output contract for engines such as Codex
 * (`--output-schema`).
 */
export const EngineResultSchema = z
  .object({
    spec: SiteSpecSchema,
    summary: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .describe(
        'Two or three sentences for the operator: the structure chosen and anything left out for lack of facts.',
      ),
    factsUsed: z.array(FactIdSchema).max(500).describe('Every fact id the site states.'),
  })
  .strict()
  .meta({ id: 'SiteEngineResult', title: 'Site engine result v1' });
export type EngineResult = z.infer<typeof EngineResultSchema>;
