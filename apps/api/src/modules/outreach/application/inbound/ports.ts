import type { InboundKind, Triage, TriageClass } from '@bf/contracts';

// Ports of reply ingestion (BF-054).

/** A message parsed in memory (nothing is stored before the privacy filter says it belongs to outreach). */
export interface ParsedMail {
  readonly contentType: string;
  readonly headers: Readonly<Record<string, string[]>>;
  readonly from: { readonly email: string; readonly name: string | null } | null;
  readonly to: string[];
  readonly cc: string[];
  readonly subject: string;
  readonly date: Date | null;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: string[];
  readonly text: string;
  readonly html: string | null;
  /** Parts as text: DSN `message/delivery-status`, original headers, attachments' metadata. */
  readonly parts: {
    readonly contentType: string;
    readonly content: string;
    readonly filename: string | null;
    readonly size: number;
  }[];
}

export interface MailParser {
  parse(raw: Buffer): Promise<ParsedMail>;
}
export const MAIL_PARSER = Symbol('MailParser');

export interface HtmlSanitizer {
  /** Safe HTML (no scripts, styles, forms, event handlers); remote images replaced unless allowed. */
  sanitize(html: string): { readonly html: string; readonly hasRemoteImages: boolean };
  toText(html: string): string;
}
export const HTML_SANITIZER = Symbol('HtmlSanitizer');

export interface InboundRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly mailboxId: string;
  readonly threadId: string;
  readonly outboundMessageId: string | null;
  readonly providerMessageId: string;
  readonly rfc822MessageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: string[];
  readonly fromEmail: string | null;
  readonly fromName: string | null;
  readonly to: string[];
  readonly cc: string[];
  readonly subject: string;
  readonly receivedAt: Date;
  readonly bodyText: string;
  readonly bodyHtmlSanitized: string | null;
  readonly hasRemoteImages: boolean;
  readonly snippet: string;
  readonly attachments: { filename: string | null; contentType: string; size: number }[];
  readonly kind: InboundKind;
  readonly dsn: {
    action: string;
    status: string | null;
    permanent: boolean;
    recipient: string | null;
    diagnostic: string | null;
  } | null;
  readonly autoReplyUntil: string | null;
  readonly unsubscribeDetected: boolean;
  readonly triage: Triage | null;
  readonly triageStatus: 'pending' | 'done' | 'needs_human' | 'corrected';
  readonly correctedClass: TriageClass | null;
  readonly correctedBy: string | null;
  readonly correctedAt: Date | null;
  readonly status: 'new' | 'read' | 'handled' | 'snoozed';
  readonly assignedTo: string | null;
  readonly snoozedUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type NewInbound = Omit<
  InboundRecord,
  | 'triage'
  | 'triageStatus'
  | 'correctedClass'
  | 'correctedBy'
  | 'correctedAt'
  | 'status'
  | 'assignedTo'
  | 'snoozedUntil'
  | 'createdAt'
  | 'updatedAt'
>;

export interface OutboundRef {
  readonly id: string;
  readonly organizationId: string;
  readonly businessId: string;
  readonly contactId: string | null;
  readonly threadId: string;
  readonly mailboxId: string | null;
  readonly status: string;
  readonly toEmail: string | null;
  readonly rfc822MessageId: string;
}

export interface SyncState {
  readonly mailboxId: string;
  readonly organizationId: string;
  readonly cursor: Record<string, unknown> | null;
  readonly nextPollAt: Date;
  readonly consecutiveErrors: number;
}

export interface InboundRepository {
  /** Our outbound messages among these Message-IDs (normalized, lower case), in the workspace. */
  outboundByMessageIds(organizationId: string, messageIds: readonly string[]): Promise<OutboundRef[]>;
  /** Threads of the workspace with these provider thread ids. */
  threadsByProviderId(
    organizationId: string,
    providerThreadIds: readonly string[],
  ): Promise<{ id: string; providerThreadId: string }[]>;
  /** The latest outbound message of a thread (the parent of a reply matched by thread). */
  latestOutbound(threadId: string): Promise<OutboundRef | undefined>;
  /**
   * The outbound messages sent from this mailbox to this address since `since` (the fallback match by sender and
   * subject), with their thread subjects.
   */
  recentlyEmailed(
    mailboxId: string,
    email: string,
    since: Date,
  ): Promise<(OutboundRef & { subject: string })[]>;
  /** Inserts unless this mailbox already holds the provider message (at-least-once sync). */
  insert(row: NewInbound): Promise<InboundRecord | undefined>;
  get(organizationId: string, id: string): Promise<InboundRecord | undefined>;
  byId(id: string): Promise<InboundRecord | undefined>;
  update(
    id: string,
    patch: Partial<Omit<InboundRecord, 'id' | 'organizationId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<InboundRecord | undefined>;
  /** The thread got a reply: inbox fields, and `replied` for a human one. */
  touchThread(
    threadId: string,
    at: Date,
    input: { readonly human: boolean; readonly triageClass?: string | null },
  ): Promise<void>;
  /** Soft bounces of an address in the workspace since `since` (three in 7 days count as a hard bounce). */
  softBounces(organizationId: string, email: string, since: Date): Promise<number>;
  // Sync state
  syncState(mailboxId: string): Promise<SyncState | undefined>;
  saveSync(
    mailboxId: string,
    organizationId: string,
    patch: {
      readonly cursor?: Record<string, unknown> | null;
      readonly nextPollAt: Date;
      readonly lastSuccessAt?: Date;
      readonly lastErrorAt?: Date;
      readonly lastError?: string | null;
      readonly consecutiveErrors: number;
      readonly lagSeconds?: number | null;
      readonly ingested?: number;
      readonly ignored?: number;
    },
  ): Promise<void>;
  /** Connected mailboxes whose next poll is due (or that were never synced). */
  dueMailboxes(now: Date, limit: number): Promise<{ id: string; organizationId: string }[]>;
}
export const INBOUND_REPOSITORY = Symbol('InboundRepository');

/** Enqueues work of the reply pipeline. */
export interface InboundQueues {
  sync(organizationId: string, mailboxId: string, key: string): Promise<void>;
  triage(organizationId: string, inboundId: string): Promise<void>;
}
export const INBOUND_QUEUES = Symbol('InboundQueues');

export interface InboundSettings {
  readonly pollSeconds: number;
  /** The unsubscribe mailto address, when one is configured. */
  readonly unsubscribeMailto: string | null;
}
export const INBOUND_SETTINGS = Symbol('InboundSettings');
