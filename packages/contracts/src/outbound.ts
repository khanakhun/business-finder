import { z } from 'zod';
import { ComplianceDecisionSchema } from './compliance.ts';
import { EmailLocaleSchema, EmailPurposeSchema } from './drafting.ts';
import { defineEvent } from './events.ts';
import { BusinessId } from './ids.ts';
import { defineJob } from './jobs.ts';
import { cursorPage } from './pagination.ts';
import { OfferSchema } from './taxonomy.ts';
import { IsoDateTimeSchema } from './time.ts';

// The outbound pipeline (BF-052): one-click send with an undo window, a compliance decision persisted before a
// message is queued and re-evaluated when it is sent, the shared footer and RFC 8058 headers, and manual contact
// logs. The lifecycle is DOMAIN §3.5.

export const OUTBOUND_STATUSES = [
  'draft',
  'pending_approval',
  'queued',
  'sending',
  'sent',
  'failed',
  'blocked',
  'cancelled',
  'bounced',
  'replied',
] as const;
export const OutboundStatusSchema = z.enum(OUTBOUND_STATUSES);
export type OutboundStatus = z.infer<typeof OutboundStatusSchema>;

export const MANUAL_CONTACT_CHANNELS = ['email', 'phone', 'whatsapp', 'letter', 'in_person'] as const;
export const ManualContactChannelSchema = z.enum(MANUAL_CONTACT_CHANNELS);
export type ManualContactChannel = z.infer<typeof ManualContactChannelSchema>;

export const OutboundErrorSchema = z.object({
  code: z.string().max(60),
  message: z.string().max(500),
  retryable: z.boolean(),
  at: IsoDateTimeSchema,
});
export type OutboundError = z.infer<typeof OutboundErrorSchema>;

export const OutboundMessageSummarySchema = z
  .object({
    id: z.uuid(),
    businessId: BusinessId,
    businessName: z.string(),
    contactId: z.uuid().nullable(),
    /** Masked for the list (`j…@example.com`); the detail shows the full address. */
    recipient: z.string(),
    mailboxId: z.uuid().nullable(),
    mailboxEmail: z.string().nullable(),
    subject: z.string(),
    purpose: EmailPurposeSchema,
    offer: OfferSchema,
    locale: EmailLocaleSchema,
    status: OutboundStatusSchema,
    scheduledAt: IsoDateTimeSchema,
    sentAt: IsoDateTimeSchema.nullable(),
    attempts: z.number().int().nonnegative(),
    lastError: OutboundErrorSchema.nullable(),
    /** Why the send-time check stopped it (status `blocked`). */
    blockedReasons: z.array(z.string()),
    /** A sequence step (BF-053): which enrollment and step index sent it. */
    sequence: z.object({ enrollmentId: z.uuid(), stepIndex: z.number().int() }).nullable(),
    bulkRunId: z.uuid().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'OutboundMessageSummary' });
export type OutboundMessageSummary = z.infer<typeof OutboundMessageSummarySchema>;

export const OutboundTimelineEntrySchema = z.object({
  at: IsoDateTimeSchema,
  status: OutboundStatusSchema,
  detail: z.string().nullable(),
});

export const OutboundMessageSchema = OutboundMessageSummarySchema.extend({
  threadId: z.uuid(),
  draftId: z.uuid().nullable(),
  recipientEmail: z.string(),
  bodyText: z.string(),
  bodyHtml: z.string(),
  headers: z.record(z.string(), z.string()),
  rfc822MessageId: z.string(),
  providerMessageId: z.string().nullable(),
  enqueueDecision: ComplianceDecisionSchema.nullable(),
  sendDecision: ComplianceDecisionSchema.nullable(),
  timeline: z.array(OutboundTimelineEntrySchema),
  createdBy: z.uuid().nullable(),
  approvedBy: z.uuid().nullable(),
  approvedAt: IsoDateTimeSchema.nullable(),
}).meta({ id: 'OutboundMessage' });
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;

export const OutboundMessageListSchema = cursorPage(OutboundMessageSummarySchema).meta({
  id: 'OutboundMessageList',
});
export type OutboundMessageList = z.infer<typeof OutboundMessageListSchema>;

export const ListOutboundMessagesQuerySchema = z.object({
  /** One status or several, comma-separated. */
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(z.array(OutboundStatusSchema).optional()),
  mailboxId: z.uuid().optional(),
  businessId: BusinessId.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
export type ListOutboundMessagesQuery = z.infer<typeof ListOutboundMessagesQuerySchema>;

export const SendMessageRequestSchema = z
  .object({
    draftId: z.uuid(),
    /** Which of the draft's subject variants to send (default: the draft's current subject). */
    subjectVariantIndex: z.number().int().min(0).max(9).optional(),
    mailboxId: z.uuid().optional(),
    scheduleAt: IsoDateTimeSchema.optional(),
    sendMode: z.enum(['now', 'schedule']).default('now'),
  })
  .meta({ id: 'SendMessageRequest' });
export type SendMessageRequest = z.input<typeof SendMessageRequestSchema>;

export const RescheduleMessageRequestSchema = z
  .object({ scheduledAt: IsoDateTimeSchema })
  .meta({ id: 'RescheduleMessageRequest' });

export const ManualLogRequestSchema = z
  .object({
    businessId: BusinessId,
    contactId: z.uuid().nullable().default(null),
    channel: ManualContactChannelSchema,
    summary: z.string().trim().min(1).max(2_000),
    outcome: z.string().trim().max(200).optional(),
    purpose: z.string().trim().max(60).default('website_redesign'),
  })
  .meta({ id: 'ManualLogRequest' });
export type ManualLogRequest = z.input<typeof ManualLogRequestSchema>;

export const ManualContactLogSchema = z
  .object({
    id: z.uuid(),
    businessId: BusinessId,
    contactId: z.uuid().nullable(),
    channel: ManualContactChannelSchema,
    decisionId: z.uuid(),
    decision: z.string(),
    summary: z.string(),
    outcome: z.string().nullable(),
    createdBy: z.uuid().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'ManualContactLog' });
export type ManualContactLog = z.infer<typeof ManualContactLogSchema>;

// ── Bulk runs and approvals ──────────────────────────────────────────────────────────────────────────────────────

export const BULK_RUN_STATUSES = ['drafting', 'ready', 'completed', 'cancelled'] as const;

export const StartBulkRequestSchema = z
  .object({
    businessIds: z.array(BusinessId).min(1).max(100),
    offer: OfferSchema,
    purpose: EmailPurposeSchema.default('first_touch'),
    templateId: z.uuid().optional(),
    mode: z.enum(['ai', 'template']).default('ai'),
    mailboxStrategy: z.literal('auto').default('auto'),
  })
  .meta({ id: 'StartBulkRequest' });
export type StartBulkRequest = z.input<typeof StartBulkRequestSchema>;

export const BulkSkippedSchema = z.object({
  businessId: BusinessId,
  businessName: z.string(),
  /** `manual_only` or `blocked` (the gate), or `error` (no address, no draft). */
  decision: z.string(),
  reasons: z.array(z.string()),
  alternatives: z.array(z.string()),
  error: z.string().optional(),
});

export const BulkRunSchema = z
  .object({
    id: z.uuid(),
    offer: OfferSchema,
    purpose: EmailPurposeSchema,
    mode: z.enum(['ai', 'template']),
    status: z.enum(BULK_RUN_STATUSES),
    autoApprove: z.boolean(),
    total: z.number().int(),
    drafted: z.number().int(),
    skipped: z.number().int(),
    pending: z.number().int(),
    queued: z.number().int(),
    createdBy: z.uuid().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'BulkRun' });
export type BulkRun = z.infer<typeof BulkRunSchema>;

export const BulkItemSchema = OutboundMessageSummarySchema.extend({
  draftId: z.uuid().nullable(),
  bodyText: z.string(),
  bodyHtml: z.string(),
  /** The decision the item was drafted under (approval judges it again). */
  compliance: z.object({ decision: z.string(), reasons: z.array(z.string()) }).nullable(),
}).meta({ id: 'BulkItem' });

export const BulkRunDetailSchema = z
  .object({ run: BulkRunSchema, items: z.array(BulkItemSchema), skipped: z.array(BulkSkippedSchema) })
  .meta({ id: 'BulkRunDetail' });
export type BulkRunDetail = z.infer<typeof BulkRunDetailSchema>;

export const BulkRunListSchema = z.object({ items: z.array(BulkRunSchema) }).meta({ id: 'BulkRunList' });

export const ApproveBulkRequestSchema = z
  .object({
    /** The items to approve; omitted: every pending item of the run. */
    messageIds: z.array(z.uuid()).min(1).max(100).optional(),
    /** "Approve all": the count the person confirmed (refused when the queue changed meanwhile). */
    expectedCount: z.number().int().min(1).max(100).optional(),
  })
  .meta({ id: 'ApproveBulkRequest' });
export type ApproveBulkRequest = z.input<typeof ApproveBulkRequestSchema>;

export const RejectBulkRequestSchema = z
  .object({ messageIds: z.array(z.uuid()).min(1).max(100) })
  .meta({ id: 'RejectBulkRequest' });

export const BulkActionResultSchema = z
  .object({
    approved: z.number().int(),
    rejected: z.number().int(),
    /** Refused when judged again at approval (cancelled with their reasons). */
    refused: z.number().int(),
    failed: z.array(z.object({ messageId: z.uuid(), reason: z.string() })),
  })
  .meta({ id: 'BulkActionResult' });
export type BulkActionResult = z.infer<typeof BulkActionResultSchema>;

/** Inline edit of a message waiting for approval (its draft changes; the preview is rendered again). */
export const EditPendingMessageRequestSchema = z
  .object({
    subject: z.string().trim().min(1).max(150).optional(),
    bodyMd: z.string().trim().min(10).max(5000).optional(),
  })
  .meta({ id: 'EditPendingMessageRequest' });

/** Realtime event type of an outbound message's status change (payload: `{ status, businessId }`). */
export const OUTREACH_MESSAGE_STATUS = 'outreach.message.status';

// ── Events ──────────────────────────────────────────────────────────────────────────────────────────────────────

const messageRef = {
  messageId: z.uuid(),
  businessId: BusinessId,
  contactId: z.uuid().nullable(),
  threadId: z.uuid(),
  mailboxId: z.uuid().nullable(),
};

export const OutreachMessageQueued = defineEvent(
  'outreach.message.queued',
  1,
  z.object({ ...messageRef, scheduledAt: IsoDateTimeSchema, decisionId: z.uuid() }),
);

export const OutreachMessageCancelled = defineEvent('outreach.message.cancelled', 1, z.object(messageRef));

export const OutreachMessageSent = defineEvent(
  'outreach.message.sent',
  1,
  z.object({
    ...messageRef,
    purpose: EmailPurposeSchema,
    offer: OfferSchema,
    sequenceEnrollmentId: z.uuid().nullable(),
    sentAt: IsoDateTimeSchema,
  }),
);

export const OutreachMessageFailed = defineEvent(
  'outreach.message.failed',
  1,
  z.object({ ...messageRef, code: z.string(), retryable: z.boolean(), final: z.boolean() }),
);

export const OutreachMessageBlocked = defineEvent(
  'outreach.message.blocked',
  1,
  z.object({ ...messageRef, decisionId: z.uuid().nullable(), reasons: z.array(z.string()) }),
);

export const ManualContactLogged = defineEvent(
  'outreach.manual_contact.logged',
  1,
  z.object({
    logId: z.uuid(),
    businessId: BusinessId,
    contactId: z.uuid().nullable(),
    channel: ManualContactChannelSchema,
  }),
);

// ── Jobs ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every minute: due messages are claimed (`SKIP LOCKED`), leased and handed to the send queue. */
export const OutreachTickJob = defineJob('outreach-tick', 'tick', {});

/** One business of a bulk run: compliance first, then its draft and a message waiting for approval. */
export const OutreachBulkDraftJob = defineJob('outreach-bulk', 'draft', {
  runId: z.uuid(),
  businessId: z.uuid(),
});

/** One send attempt of a leased message; `lease` is the claim it belongs to (a stale job does nothing). */
export const OutreachSendJob = defineJob('outreach-send', 'send', {
  messageId: z.uuid(),
  lease: IsoDateTimeSchema,
});
