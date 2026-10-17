import { z } from 'zod';
import { defineJob } from './jobs.ts';
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

// ── Training (intel) ────────────────────────────────────────────────────────────────────────────────────────────

export const ML_MODEL_KINDS = ['logreg', 'hgb'] as const;
export const MlModelKindSchema = z.enum(ML_MODEL_KINDS);
export type MlModelKind = z.infer<typeof MlModelKindSchema>;

/**
 * How a feature vector becomes the model's input (shared by intel, which writes it, and the API, which scores with
 * it): one column per entry, in order. Numbers are imputed then standardized, with a missing indicator; booleans
 * are 0/1; categories are one-hot (rare and unseen values in `__other__`, null in `__missing__`).
 */
export const MlColumnSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('numeric'),
    source: z.string(),
    fill: z.number(),
    mean: z.number(),
    std: z.number(),
  }),
  z.object({ kind: z.literal('missing'), source: z.string() }),
  z.object({ kind: z.literal('boolean'), source: z.string() }),
  z.object({ kind: z.literal('category'), source: z.string(), value: z.string() }),
]);
export type MlColumn = z.infer<typeof MlColumnSchema>;

export const MlCalibrationSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('none') }),
  /** p = 1 / (1 + exp(-(a·logit(raw) + b))). */
  z.object({ method: z.literal('platt'), a: z.number(), b: z.number() }),
  /** Piecewise-linear through the points (x ascending), clamped at the ends. */
  z.object({ method: z.literal('isotonic'), x: z.array(z.number()), y: z.array(z.number()) }),
]);
export type MlCalibration = z.infer<typeof MlCalibrationSchema>;

export const MlPreprocessingSpecSchema = z
  .object({
    version: z.literal(1),
    kind: MlModelKindSchema,
    columns: z.array(MlColumnSchema),
    onnx: z.object({ inputName: z.string(), outputName: z.string(), positiveIndex: z.number().int() }),
    calibration: MlCalibrationSchema,
    /** Logistic regression only: exact explanations (coefficient × column value, summed per feature). */
    linear: z.object({ intercept: z.number(), coefficients: z.array(z.number()) }).nullable(),
  })
  .meta({ id: 'MlPreprocessingSpec' });
export type MlPreprocessingSpec = z.infer<typeof MlPreprocessingSpecSchema>;

export const MlMetricsSchema = z.object({
  rocAuc: z.number().nullable(),
  prAuc: z.number().nullable(),
  brier: z.number().nullable(),
  liftTop10: z.number().nullable(),
  liftTop20: z.number().nullable(),
  calibration: z.array(z.object({ predicted: z.number(), observed: z.number(), n: z.number().int() })),
});
export type MlMetrics = z.infer<typeof MlMetricsSchema>;

const ArtifactNames = z.object({
  model: z.string(),
  preprocessing: z.string(),
  modelCardJson: z.string(),
  modelCardMd: z.string(),
});

export const MlTrainRequestSchema = z
  .object({
    datasetId: z.uuid(),
    /** Presigned GET of the dataset (JSON Lines, gzip) and its SHA-256 (checked before use). */
    datasetUrl: z.url(),
    datasetSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Presigned PUTs for the artifacts. */
    artifactUrls: ArtifactNames,
    offer: z.string(),
    labelVersion: z.number().int(),
    horizonDays: z.number().int(),
    features: z.array(z.object({ id: z.string(), type: z.enum(ML_FEATURE_TYPES) })),
    seed: z.number().int().default(42),
    validationShare: z.number().min(0.1).max(0.5).default(0.25),
    considerGbm: z.boolean().default(true),
    gbmMinAucGain: z.number().min(0).max(0.5).default(0.03),
  })
  .meta({ id: 'MlTrainRequest' });
export type MlTrainRequest = z.input<typeof MlTrainRequestSchema>;

export const MlTrainResultSchema = z
  .object({
    kind: MlModelKindSchema,
    metrics: MlMetricsSchema,
    baselineMetrics: MlMetricsSchema,
    /** Rank correlation between the model and the rule score on the validation rows. */
    spearman: z.number().nullable(),
    trainRows: z.number().int(),
    validationRows: z.number().int(),
    /** SHA-256 of each uploaded artifact. */
    artifactHashes: ArtifactNames,
    modelCard: z.record(z.string(), z.unknown()),
    warnings: z.array(z.string()),
  })
  .meta({ id: 'MlTrainResult' });
export type MlTrainResult = z.infer<typeof MlTrainResultSchema>;

// ── Registry and training runs (API) ────────────────────────────────────────────────────────────────────────────

export const ML_MODEL_STATUSES = ['trained', 'shadow', 'active', 'retired', 'rejected'] as const;
export const MlModelStatusSchema = z.enum(ML_MODEL_STATUSES);
export type MlModelStatus = z.infer<typeof MlModelStatusSchema>;

export const MlModelSchema = z
  .object({
    id: z.uuid(),
    offer: OfferSchema,
    version: z.number().int(),
    kind: MlModelKindSchema,
    status: MlModelStatusSchema,
    datasetId: z.uuid(),
    labelVersion: z.number().int(),
    metrics: MlMetricsSchema,
    baselineMetrics: MlMetricsSchema,
    spearman: z.number().nullable(),
    modelCard: z.record(z.string(), z.unknown()),
    warnings: z.array(z.string()),
    trainedBy: z.uuid().nullable(),
    trainedAt: IsoDateTimeSchema,
    promotedBy: z.uuid().nullable(),
    promotedAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'MlModel' });
export type MlModel = z.infer<typeof MlModelSchema>;

export const ML_TRAINING_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;

export const MlTrainingRunSchema = z
  .object({
    id: z.uuid(),
    datasetId: z.uuid(),
    offer: OfferSchema,
    status: z.enum(ML_TRAINING_RUN_STATUSES),
    error: z.string().nullable(),
    modelId: z.uuid().nullable(),
    createdBy: z.uuid().nullable(),
    createdAt: IsoDateTimeSchema,
    finishedAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'MlTrainingRun' });
export type MlTrainingRun = z.infer<typeof MlTrainingRunSchema>;

export const StartMlTrainingRequestSchema = z
  .object({ datasetId: z.uuid(), considerGbm: z.boolean().default(true) })
  .meta({ id: 'StartMlTrainingRequest' });
export type StartMlTrainingRequest = z.input<typeof StartMlTrainingRequestSchema>;

/** Trains a model in intel for one training run (worker; one at a time, one attempt). */
export const ScoringMlTrainJob = defineJob('scoring-ml-train', 'train', { runId: z.uuid() });
