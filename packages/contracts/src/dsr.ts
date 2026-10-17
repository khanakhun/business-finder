import { z } from 'zod';
import { defineEvent } from './events.ts';
import { BusinessId } from './ids.ts';
import { IsoDateTimeSchema } from './time.ts';

// Data-subject requests and retention (BF-055, GDPR art. 15–21): access, erasure, objection, rectification and
// restriction across every module that stores personal data, with a one-month deadline, verification, an audited
// trail and exports; and the retention registry with its daily runs.

export const DSR_TYPES = ['access', 'erasure', 'objection', 'rectification', 'restriction'] as const;
export const DsrTypeSchema = z.enum(DSR_TYPES);
export type DsrType = z.infer<typeof DsrTypeSchema>;

export const DSR_STATUSES = ['received', 'verifying', 'in_progress', 'completed', 'rejected'] as const;
export const DsrStatusSchema = z.enum(DSR_STATUSES);
export type DsrStatus = z.infer<typeof DsrStatusSchema>;

export const DataSubjectSchema = z
  .object({
    email: z.email().max(320).optional(),
    phone: z.string().trim().min(5).max(40).optional(),
    name: z.string().trim().min(2).max(200).optional(),
    businessId: BusinessId.optional(),
  })
  .refine((subject) => Boolean(subject.email || subject.phone || subject.name), {
    message: 'An email, a phone number or a name is needed',
  })
  .meta({ id: 'DataSubject' });
export type DataSubject = z.infer<typeof DataSubjectSchema>;

export const DSR_VERIFICATION_METHODS = ['email_reply', 'known_contact', 'id_document', 'other'] as const;

export const DsrActionSchema = z.object({
  at: IsoDateTimeSchema,
  kind: z.string(),
  by: z.uuid().nullable(),
  detail: z.record(z.string(), z.unknown()),
});
export type DsrAction = z.infer<typeof DsrActionSchema>;

export const DsrRequestSchema = z
  .object({
    id: z.uuid(),
    type: DsrTypeSchema,
    status: DsrStatusSchema,
    source: z.enum(['admin', 'public']),
    /** Decrypted for the people handling it; null once erased. */
    subject: z
      .object({
        email: z.string().optional(),
        phone: z.string().optional(),
        name: z.string().optional(),
        businessId: z.string().optional(),
      })
      .nullable(),
    receivedAt: IsoDateTimeSchema,
    dueAt: IsoDateTimeSchema,
    verification: z
      .object({
        method: z.enum(DSR_VERIFICATION_METHODS),
        notes: z.string(),
        at: IsoDateTimeSchema,
        by: z.uuid().nullable(),
      })
      .nullable(),
    actions: z.array(DsrActionSchema),
    exportReady: z.boolean(),
    handledBy: z.uuid().nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'DsrRequest' });
export type DsrRequest = z.infer<typeof DsrRequestSchema>;

export const DsrRequestListSchema = z
  .object({ items: z.array(DsrRequestSchema) })
  .meta({ id: 'DsrRequestList' });

export const CreateDsrRequestSchema = z
  .object({ type: DsrTypeSchema, subject: DataSubjectSchema, notes: z.string().trim().max(2000).optional() })
  .meta({ id: 'CreateDsrRequest' });
export type CreateDsrRequest = z.input<typeof CreateDsrRequestSchema>;

export const VerifyDsrRequestSchema = z
  .object({ method: z.enum(DSR_VERIFICATION_METHODS), notes: z.string().trim().min(3).max(2000) })
  .meta({ id: 'VerifyDsrRequest' });

export const RejectDsrRequestSchema = z
  .object({ reason: z.string().trim().min(3).max(2000) })
  .meta({ id: 'RejectDsrRequest' });

export const ExecuteDsrRequestSchema = z
  .object({
    /** Erasure: delete rows, or anonymize them where a record must stay (default). */
    mode: z.enum(['delete', 'anonymize']).default('anonymize'),
    /** Rectification and restriction: what was done (recorded in the trail). */
    notes: z.string().trim().max(2000).optional(),
  })
  .meta({ id: 'ExecuteDsrRequest' });
export type ExecuteDsrRequest = z.input<typeof ExecuteDsrRequestSchema>;

export const DsrDiscoverySchema = z
  .object({
    providers: z.array(
      z.object({
        id: z.string(),
        categories: z.array(z.string()),
        records: z.number().int(),
        /** Short, redacted descriptions of what was found (no full values). */
        sample: z.array(z.string()).max(5),
        /** A person must review these (free text mentioning the identifier). */
        manualReview: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'DsrDiscovery' });
export type DsrDiscovery = z.infer<typeof DsrDiscoverySchema>;

/** The public "exercise your rights" form (BF-048 privacy page). */
export const PublicDsrIntakeSchema = z
  .object({
    type: DsrTypeSchema,
    email: z.email().max(320),
    name: z.string().trim().max(200).optional(),
    message: z.string().trim().max(2000).optional(),
    /** The preview site's signed token (identifies the workspace). */
    siteToken: z.string().min(10).max(2000),
  })
  .meta({ id: 'PublicDsrIntake' });
export type PublicDsrIntake = z.infer<typeof PublicDsrIntakeSchema>;

export const DsrRequestCreated = defineEvent(
  'compliance.dsr.created',
  1,
  z.object({
    requestId: z.uuid(),
    type: DsrTypeSchema,
    source: z.enum(['admin', 'public']),
    dueAt: IsoDateTimeSchema,
  }),
);

// ── Retention ───────────────────────────────────────────────────────────────────────────────────────────────────

export const RETENTION_ACTIONS = ['delete', 'anonymize', 'truncate_payload'] as const;

export const RetentionPolicySchema = z
  .object({
    id: z.string(),
    entity: z.string(),
    description: z.string(),
    retentionDays: z.number().int(),
    action: z.enum(RETENTION_ACTIONS),
  })
  .meta({ id: 'RetentionPolicy' });
export type RetentionPolicyView = z.infer<typeof RetentionPolicySchema>;

export const RetentionRunSchema = z
  .object({
    id: z.uuid(),
    dryRun: z.boolean(),
    startedAt: IsoDateTimeSchema,
    finishedAt: IsoDateTimeSchema.nullable(),
    results: z.array(
      z.object({
        policy: z.string(),
        count: z.number().int(),
        durationMs: z.number().int(),
        error: z.string().nullable(),
      }),
    ),
    triggeredBy: z.uuid().nullable(),
  })
  .meta({ id: 'RetentionRun' });
export type RetentionRun = z.infer<typeof RetentionRunSchema>;

export const RetentionOverviewSchema = z
  .object({ policies: z.array(RetentionPolicySchema), runs: z.array(RetentionRunSchema) })
  .meta({ id: 'RetentionOverview' });
