import { z } from 'zod';
import { OfferSchema } from './taxonomy.ts';
import { IsoDateTimeSchema } from './time.ts';

// Outcome-trained scoring (BF-059): labelled datasets of first contacts (features known at the contact, the outcome
// within a horizon), the data readiness gate, and — in later parts — trained models, shadow scores and promotion.

export const ML_MIN_LABELLED = 300;
export const ML_MIN_POSITIVES = 30;

export const MlReadinessSchema = z
  .object({
    offer: OfferSchema,
    labelVersion: z.number().int(),
    horizonDays: z.number().int(),
    labelled: z.number().int(),
    positives: z.number().int(),
    censored: z.number().int(),
    excluded: z.number().int(),
    required: z.object({ labelled: z.number().int(), positives: z.number().int() }),
    ready: z.boolean(),
  })
  .meta({ id: 'MlReadiness' });
export type MlReadiness = z.infer<typeof MlReadinessSchema>;

export const ML_FEATURE_TYPES = ['numeric', 'categorical', 'boolean'] as const;

export const MlDatasetSchema = z
  .object({
    id: z.uuid(),
    offer: OfferSchema,
    labelVersion: z.number().int(),
    horizonDays: z.number().int(),
    /** First contacts from `from` (inclusive) to `to` (exclusive). */
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
    counts: z.object({
      rows: z.number().int(),
      positives: z.number().int(),
      negatives: z.number().int(),
      censored: z.number().int(),
      excluded: z.number().int(),
    }),
    features: z.array(z.object({ id: z.string(), type: z.enum(ML_FEATURE_TYPES) })),
    /** SHA-256 of the dataset file (JSON Lines, gzip). */
    sha256: z.string(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'MlDataset' });
export type MlDataset = z.infer<typeof MlDatasetSchema>;

export const BuildMlDatasetRequestSchema = z
  .object({
    offer: OfferSchema.default('website_redesign'),
    /** Contacts since this date (default: everything). */
    from: IsoDateTimeSchema.optional(),
  })
  .meta({ id: 'BuildMlDatasetRequest' });
export type BuildMlDatasetRequest = z.input<typeof BuildMlDatasetRequestSchema>;

export const MlReadinessQuerySchema = z.object({ offer: OfferSchema.default('website_redesign') });
