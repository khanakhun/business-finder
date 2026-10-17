import { z } from 'zod';
import { EmailLocaleSchema } from './drafting.ts';
import { defineEvent } from './events.ts';
import { BusinessId } from './ids.ts';
import { defineJob } from './jobs.ts';
import { OutboundMessageSummarySchema } from './outbound.ts';
import { IsoDateTimeSchema } from './time.ts';

// Replies (BF-054): only messages that belong to outreach conversations are ingested (privacy filter before storage);
// bounces and automatic replies are parsed deterministically; human replies are triaged by a model (untrusted input,
// confidence, injection awareness), and a deterministic policy acts on the result.

export const INBOUND_KINDS = ['human', 'auto_reply', 'bounce', 'unsubscribe_mailto'] as const;
export const InboundKindSchema = z.enum(INBOUND_KINDS);
export type InboundKind = z.infer<typeof InboundKindSchema>;

/** DOMAIN "Reply triage" classes (`bounce` is a kind, decided by the parser, not a model class). */
export const TRIAGE_CLASSES = [
  'interested',
  'question',
  'not_now',
  'referral',
  'unsubscribe',
  'negative',
  'auto_reply',
] as const;
export const TriageClassSchema = z.enum(TRIAGE_CLASSES);
export type TriageClass = z.infer<typeof TriageClassSchema>;

export const TRIAGE_STATUSES = ['pending', 'done', 'needs_human', 'corrected'] as const;
export const INBOUND_STATUSES = ['new', 'read', 'handled', 'snoozed'] as const;
export const InboundStatusSchema = z.enum(INBOUND_STATUSES);

export const TriageEntitiesSchema = z.object({
  phone: z.string().max(40).nullable(),
  preferredTime: z.string().max(120).nullable(),
  followUpOn: z.iso.date().nullable(),
  referral: z
    .object({
      name: z.string().max(120).nullable(),
      email: z.string().max(320).nullable(),
      role: z.string().max(120).nullable(),
    })
    .nullable(),
  priceQuestion: z.boolean(),
  meetingRequest: z.boolean(),
});
export type TriageEntities = z.infer<typeof TriageEntitiesSchema>;

export const TriageSchema = z
  .object({
    class: TriageClassSchema,
    confidence: z.number().min(0).max(1),
    language: z.string().max(10),
    /** One line, in the workspace's language. */
    summary: z.string().max(300),
    entities: TriageEntitiesSchema,
    suggestedNextAction: z.string().max(200),
    injectionSuspected: z.boolean(),
    model: z.string(),
    promptVersion: z.string(),
  })
  .meta({ id: 'ReplyTriage' });
export type Triage = z.infer<typeof TriageSchema>;

export const DsnSchema = z.object({
  action: z.string(),
  status: z.string().nullable(),
  permanent: z.boolean(),
  recipient: z.string().nullable(),
  diagnostic: z.string().nullable(),
});

export const InboundMessageSchema = z
  .object({
    id: z.uuid(),
    threadId: z.uuid(),
    mailboxId: z.uuid(),
    outboundMessageId: z.uuid().nullable(),
    fromEmail: z.string(),
    fromName: z.string().nullable(),
    subject: z.string(),
    receivedAt: IsoDateTimeSchema,
    snippet: z.string(),
    bodyText: z.string(),
    /** Sanitized server-side (no scripts, no event handlers, remote images replaced); render it sandboxed. */
    bodyHtml: z.string().nullable(),
    hasRemoteImages: z.boolean(),
    kind: InboundKindSchema,
    dsn: DsnSchema.nullable(),
    autoReplyUntil: z.iso.date().nullable(),
    triage: TriageSchema.nullable(),
    triageStatus: z.enum(TRIAGE_STATUSES),
    correctedClass: TriageClassSchema.nullable(),
    status: InboundStatusSchema,
    assignedTo: z.uuid().nullable(),
    snoozedUntil: IsoDateTimeSchema.nullable(),
    attachments: z.array(
      z.object({ filename: z.string().nullable(), contentType: z.string(), size: z.number() }),
    ),
  })
  .meta({ id: 'InboundMessage' });
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const InboxThreadSchema = z
  .object({
    threadId: z.uuid(),
    businessId: BusinessId,
    businessName: z.string(),
    contactEmail: z.string().nullable(),
    mailboxId: z.uuid().nullable(),
    mailboxEmail: z.string().nullable(),
    subject: z.string(),
    lastInboundAt: IsoDateTimeSchema.nullable(),
    lastMessageAt: IsoDateTimeSchema,
    unreadCount: z.number().int(),
    latestClass: TriageClassSchema.nullable(),
    latestKind: InboundKindSchema.nullable(),
    needsHuman: z.boolean(),
    snippet: z.string(),
    status: InboundStatusSchema,
    assignedTo: z.uuid().nullable(),
  })
  .meta({ id: 'InboxThread' });
export type InboxThread = z.infer<typeof InboxThreadSchema>;

export const InboxThreadListSchema = z
  .object({ items: z.array(InboxThreadSchema), nextCursor: z.string().nullable(), unread: z.number().int() })
  .meta({ id: 'InboxThreadList' });
export type InboxThreadList = z.infer<typeof InboxThreadListSchema>;

export const InboxQuerySchema = z.object({
  class: TriageClassSchema.optional(),
  mailboxId: z.uuid().optional(),
  unread: z.stringbool().optional(),
  needsHuman: z.stringbool().optional(),
  assignedToMe: z.stringbool().optional(),
  status: InboundStatusSchema.optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
export type InboxQuery = z.infer<typeof InboxQuerySchema>;

export const InboxThreadDetailSchema = z
  .object({
    thread: InboxThreadSchema,
    /** Our messages and theirs, oldest first. */
    entries: z.array(
      z.discriminatedUnion('direction', [
        z.object({
          direction: z.literal('outbound'),
          message: OutboundMessageSummarySchema.extend({ bodyText: z.string() }),
        }),
        z.object({ direction: z.literal('inbound'), message: InboundMessageSchema }),
      ]),
    ),
  })
  .meta({ id: 'InboxThreadDetail' });
export type InboxThreadDetail = z.infer<typeof InboxThreadDetailSchema>;

export const UpdateInboundRequestSchema = z
  .object({
    status: InboundStatusSchema.optional(),
    assignedTo: z.uuid().nullable().optional(),
    snoozedUntil: IsoDateTimeSchema.nullable().optional(),
  })
  .meta({ id: 'UpdateInboundRequest' });
export type UpdateInboundRequest = z.input<typeof UpdateInboundRequestSchema>;

export const CorrectTriageRequestSchema = z
  .object({ class: TriageClassSchema, note: z.string().trim().max(300).optional() })
  .meta({ id: 'CorrectTriageRequest' });
export type CorrectTriageRequest = z.input<typeof CorrectTriageRequestSchema>;

export const SuggestReplyRequestSchema = z
  .object({ locale: EmailLocaleSchema.optional(), instructions: z.string().trim().max(300).optional() })
  .meta({ id: 'SuggestReplyRequest' });

// ── Events ──────────────────────────────────────────────────────────────────────────────────────────────────────

const inboundRef = {
  inboundId: z.uuid(),
  threadId: z.uuid(),
  businessId: BusinessId,
  contactId: z.uuid().nullable(),
  outboundMessageId: z.uuid().nullable(),
};

/** Emitted on receipt, before triage: sequences stop at once (BF-053). */
export const OutreachReplyReceived = defineEvent(
  'outreach.reply.received',
  1,
  z.object({ ...inboundRef, kind: InboundKindSchema, autoReplyUntil: z.iso.date().nullable() }),
);

export const OutreachReplyTriaged = defineEvent(
  'outreach.reply.triaged',
  1,
  z.object({
    ...inboundRef,
    class: TriageClassSchema,
    confidence: z.number(),
    needsHuman: z.boolean(),
    unsubscribeDetected: z.boolean(),
    corrected: z.boolean(),
  }),
);

export const OutreachMessageBounced = defineEvent(
  'outreach.message.bounced',
  1,
  z.object({
    messageId: z.uuid(),
    businessId: BusinessId,
    contactId: z.uuid().nullable(),
    mailboxId: z.uuid().nullable(),
    permanent: z.boolean(),
    status: z.string().nullable(),
  }),
);

/** Realtime: a reply arrived or changed (payload `{ threadId, businessId }`). */
export const OUTREACH_INBOX_CHANGED = 'outreach.inbox.changed';

// ── Jobs ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One mailbox's sync (poll, or after a push notification). */
export const OutreachSyncJob = defineJob('outreach-sync', 'sync', { mailboxId: z.uuid() });

/** The triage of one human reply (then the action policy). */
export const OutreachTriageJob = defineJob('outreach-triage', 'triage', { inboundId: z.uuid() });
