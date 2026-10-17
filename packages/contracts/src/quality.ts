import { z } from 'zod';
import { EngineIdSchema } from './generation.ts';

// The quality gates' language (BF-045): every gate reports issues in one shape — where (a page, a block, a path, a
// locale), how bad, whether an engine can repair it or a deterministic fix applies — and the pipeline's report keeps
// each gate's outcome, the fixes applied, the 0–100 score and the decision. Stored once on the site version.

export const QUALITY_GATES = [
  'schema',
  'facts',
  'claims',
  'copy',
  'autofix',
  'a11y',
  'performance',
  'visual',
] as const;
export const QualityGateIdSchema = z.enum(QUALITY_GATES);
export type QualityGateId = z.infer<typeof QualityGateIdSchema>;

export const QUALITY_DECISIONS = ['pass', 'repair', 'needs_review'] as const;
export type QualityDecision = (typeof QUALITY_DECISIONS)[number];

export const QualityIssueSchema = z
  .object({
    gate: QualityGateIdSchema,
    /** The check's code (`fact_unknown`, `copy.superlative`, `color-contrast`…). */
    code: z.string().max(80),
    severity: z.enum(['error', 'warning', 'info']),
    /** What to change, in one sentence. */
    message: z.string().max(600),
    target: z
      .object({
        pageId: z.string().max(80).optional(),
        blockId: z.string().max(80).optional(),
        /** The spec path, dotted (`pages[0].blocks[2].props.title.fr`). */
        path: z.string().max(300).optional(),
        locale: z.string().max(5).optional(),
      })
      .optional(),
    evidence: z.string().max(600).optional(),
    /** An engine can fix it by editing the site (not a platform problem, not ambiguous). */
    repairable: z.boolean(),
    /** A deterministic fix exists (the auto-fixer applies it). */
    autoFixable: z.boolean(),
    /** Caused by the platform (renderer, fonts, scripts), not the content: no repair, an alert. */
    platform: z.boolean().optional(),
    suggestedFix: z.string().max(400).optional(),
  })
  .meta({ id: 'QualityIssue' });
export type QualityIssue = z.infer<typeof QualityIssueSchema>;

export const QualityGateResultSchema = z
  .object({
    id: QualityGateIdSchema,
    /** `error`: the gate itself failed (infrastructure), never a pass. */
    status: z.enum(['pass', 'fail', 'skipped', 'error']),
    score: z.number().min(0).max(100).optional(),
    durationMs: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    issues: z.array(QualityIssueSchema).max(500),
    /** The visual critic's rubric: criterion → 1–5. */
    rubric: z.record(z.string().max(40), z.number().min(1).max(5)).optional(),
    /** Model and prompt versions of an AI gate (reproducibility). */
    model: z.string().max(80).optional(),
    promptVersion: z.number().int().positive().optional(),
  })
  .meta({ id: 'QualityGateResult' });
export type QualityGateResult = z.infer<typeof QualityGateResultSchema>;

export const QualityAutoFixSchema = z.object({
  rule: z.string().max(80),
  path: z.string().max(300),
  before: z.string().max(2000).optional(),
  after: z.string().max(2000).optional(),
});
export type QualityAutoFix = z.infer<typeof QualityAutoFixSchema>;

export const QualityReportSchema = z
  .object({
    pipelineVersion: z.number().int().positive(),
    /** SHA-256 of the candidate spec the report is about (after auto-fixes). */
    candidateHash: z.string().regex(/^[0-9a-f]{64}$/),
    score: z.number().int().min(0).max(100),
    decision: z.enum(QUALITY_DECISIONS),
    /** A gate could not run: never a pass, a person looks. */
    infraError: z.boolean(),
    gates: z.array(QualityGateResultSchema).max(QUALITY_GATES.length),
    autoFixes: z.array(QualityAutoFixSchema).max(200),
    /** The issues sent for repair (prioritized, at most 12) or left for review. */
    issues: z.array(QualityIssueSchema).max(100),
    screenshots: z
      .array(z.object({ page: z.string().max(80), viewport: z.string().max(20), ref: z.string().max(500) }))
      .max(40),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'QualityReport' });
export type QualityReport = z.infer<typeof QualityReportSchema>;

/** Publish a version the gates sent to review (BF-045): who decided is recorded, and why. */
export const AcceptGenerationJobRequestSchema = z
  .object({ reason: z.string().trim().min(10).max(500) })
  .meta({ id: 'AcceptGenerationJobRequest' });
export type AcceptGenerationJobRequest = z.infer<typeof AcceptGenerationJobRequestSchema>;

/** A repair attempt asked by a person, on the report's issues (on another engine if given). */
export const RepairGenerationJobRequestSchema = z
  .object({ engine: EngineIdSchema.optional() })
  .meta({ id: 'RepairGenerationJobRequest' });
export type RepairGenerationJobRequest = z.infer<typeof RepairGenerationJobRequestSchema>;

/** A job's quality report (BF-045): null until the gates have produced one. */
export const GenerationJobQualitySchema = z
  .object({ report: QualityReportSchema.nullable() })
  .meta({ id: 'GenerationJobQuality' });
export type GenerationJobQuality = z.infer<typeof GenerationJobQualitySchema>;
