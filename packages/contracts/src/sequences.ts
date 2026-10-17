import { z } from 'zod';
import { defineEvent } from './events.ts';
import { BusinessId } from './ids.ts';
import { defineJob } from './jobs.ts';
import { HolidayCalendarSchema } from './mailbox.ts';
import { OfferSchema } from './taxonomy.ts';
import { IsoDateTimeSchema } from './time.ts';

// Sequences (BF-053): a few well-spaced follow-ups in business days, in the same thread and from the same mailbox,
// that stop at once on a reply, a bounce, an unsubscribe, a lead or a pipeline change. Every email step goes through
// the outbound pipeline (BF-052), which judges compliance again. Definitions are versioned; an enrollment stays on its
// version.

export const SEQUENCE_STATUSES = ['draft', 'active', 'archived'] as const;
export const SequenceStatusSchema = z.enum(SEQUENCE_STATUSES);

export const STEP_KINDS = ['email', 'task_call', 'task_whatsapp', 'task_custom'] as const;
export const StepKindSchema = z.enum(STEP_KINDS);

export const STEP_CONDITIONS = ['always', 'previewViewed', 'previewNotViewed'] as const;

export const STOP_REASONS = [
  'replied',
  'bounced',
  'unsubscribed',
  'suppressed',
  'do_not_contact',
  'converted',
  'pipeline_changed',
  'manual',
  'contact_invalid',
  'mailbox_removed',
  'compliance_blocked',
  'completed',
] as const;
export const StopReasonSchema = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof StopReasonSchema>;

const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const SequenceVariantSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  weight: z.number().int().min(0).max(100),
  templateId: z.uuid().nullable().default(null),
  /** AI instructions when no template is used (the draft is grounded like any BF-051 draft). */
  instructions: z.string().trim().max(300).nullable().default(null),
});

export const SequenceStepSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  kind: StepKindSchema,
  wait: z.object({
    businessDays: z.number().int().min(0).max(30),
    /** In the recipient's time zone; the mailbox's sending window still applies. */
    preferredLocalTime: LocalTime.nullable().default(null),
  }),
  condition: z.enum(STEP_CONDITIONS).default('always'),
  /** Email steps. */
  threading: z.enum(['reply_in_thread', 'new_thread']).default('reply_in_thread'),
  variants: z.array(SequenceVariantSchema).max(4).default([]),
  /** Task steps: what the person should do. */
  taskTitle: z.string().trim().max(200).nullable().default(null),
  /** Skip the step when the contact has no verified email (email steps). */
  skipIfUnverified: z.boolean().default(false),
});
export type SequenceStep = z.infer<typeof SequenceStepSchema>;

export const SequenceSettingsSchema = z.object({
  calendars: z.array(HolidayCalendarSchema).max(4).default(['FR']),
  maxEmails: z.number().int().min(1).max(4).default(3),
  minGapBusinessDays: z.number().int().min(2).max(30).default(2),
  /** `always`: every email waits in the approvals queue; `auto_when_permitted`: only when auto-send is not allowed. */
  approval: z.enum(['always', 'auto_when_permitted']).default('auto_when_permitted'),
  /** The stop conditions a sequence may turn off (the rest always apply). */
  stopOnPreviewLead: z.boolean().default(true),
});
export type SequenceSettings = z.infer<typeof SequenceSettingsSchema>;

export const SaveSequenceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    offer: OfferSchema,
    settings: SequenceSettingsSchema,
    steps: z.array(SequenceStepSchema).min(1).max(8),
  })
  .meta({ id: 'SaveSequenceRequest' });
export type SaveSequenceRequest = z.input<typeof SaveSequenceRequestSchema>;

export const SequenceIssueSchema = z.object({ path: z.string(), code: z.string(), message: z.string() });

export const SequenceSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    offer: OfferSchema,
    status: SequenceStatusSchema,
    version: z.number().int(),
    versionId: z.uuid(),
    settings: SequenceSettingsSchema,
    steps: z.array(SequenceStepSchema),
    activeEnrollments: z.number().int(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Sequence' });
export type Sequence = z.infer<typeof SequenceSchema>;

export const SequenceListSchema = z.object({ items: z.array(SequenceSchema) }).meta({ id: 'SequenceList' });

export const EnrollRequestSchema = z
  .object({
    items: z
      .array(z.object({ businessId: BusinessId, contactId: z.uuid().nullable().default(null) }))
      .min(1)
      .max(100)
      .optional(),
    /** Attach the sequence after a first email (its business, contact, mailbox and thread). */
    fromMessageId: z.uuid().optional(),
  })
  .refine((value) => (value.items ? !value.fromMessageId : !!value.fromMessageId), {
    message: 'Give items or fromMessageId',
  })
  .meta({ id: 'EnrollRequest' });
export type EnrollRequest = z.input<typeof EnrollRequestSchema>;

export const ENROLLMENT_STATUSES = ['active', 'paused', 'completed', 'stopped'] as const;
export const EnrollmentStatusSchema = z.enum(ENROLLMENT_STATUSES);
export type EnrollmentStatus = z.infer<typeof EnrollmentStatusSchema>;

export const EnrollmentEventSchema = z.object({
  at: IsoDateTimeSchema,
  kind: z.enum([
    'enrolled',
    'executed',
    'skipped',
    'paused',
    'resumed',
    'stopped',
    'rescheduled',
    'completed',
  ]),
  stepId: z.string().nullable(),
  detail: z.string().nullable(),
  messageId: z.uuid().nullable(),
});

export const EnrollmentSchema = z
  .object({
    id: z.uuid(),
    sequenceId: z.uuid(),
    sequenceName: z.string(),
    version: z.number().int(),
    businessId: BusinessId,
    contactId: z.uuid().nullable(),
    mailboxId: z.uuid().nullable(),
    status: EnrollmentStatusSchema,
    currentStepIndex: z.number().int(),
    stepCount: z.number().int(),
    nextRunAt: IsoDateTimeSchema.nullable(),
    variantAssignments: z.record(z.string(), z.string()),
    stopReason: z.string().nullable(),
    pauseReason: z.string().nullable(),
    stoppedAt: IsoDateTimeSchema.nullable(),
    events: z.array(EnrollmentEventSchema),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Enrollment' });
export type Enrollment = z.infer<typeof EnrollmentSchema>;

export const EnrollmentListSchema = z
  .object({ items: z.array(EnrollmentSchema) })
  .meta({ id: 'EnrollmentList' });

export const EnrollResultSchema = z
  .object({
    enrolled: z.array(EnrollmentSchema),
    skipped: z.array(z.object({ businessId: BusinessId, reason: z.string() })),
  })
  .meta({ id: 'EnrollResult' });
export type EnrollResult = z.infer<typeof EnrollResultSchema>;

const Rate = z.object({
  n: z.number().int(),
  rate: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
  /** Fewer than 30 sends: the interval is too wide to compare variants. */
  insufficient: z.boolean(),
});

export const SequenceStatsSchema = z
  .object({
    sequenceId: z.uuid(),
    steps: z.array(
      z.object({
        stepId: z.string(),
        variants: z.array(
          z.object({
            variantId: z.string(),
            sent: z.number().int(),
            replies: Rate,
            positive: Rate,
            bounces: Rate,
            unsubscribes: Rate,
            previewViews: Rate,
          }),
        ),
      }),
    ),
  })
  .meta({ id: 'SequenceStats' });
export type SequenceStats = z.infer<typeof SequenceStatsSchema>;

// ── Events ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const EnrollmentStopped = defineEvent(
  'outreach.enrollment.stopped',
  1,
  z.object({ enrollmentId: z.uuid(), businessId: BusinessId, reason: StopReasonSchema }),
);

/** One due step of an enrollment (claimed by the outreach tick with a lease). */
export const OutreachSequenceStepJob = defineJob('outreach-sequence', 'step', {
  enrollmentId: z.uuid(),
  lease: IsoDateTimeSchema,
});
