import { z } from 'zod';
import { ComplianceDecisionSchema } from './compliance.ts';
import { EmailLocaleSchema, EmailPurposeSchema } from './drafting.ts';
import { defineEvent } from './events.ts';
import { BusinessId } from './ids.ts';
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
