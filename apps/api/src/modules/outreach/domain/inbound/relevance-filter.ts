// Which messages of a partner's mailbox belong to outreach (BF-054, privacy by design). The mailbox also holds the
// partner's private mail: a message is kept only when it answers or bounces one of our messages, sits in one of our
// threads, was sent to our unsubscribe address, or — fallback — comes from a contact we emailed from this mailbox in
// the last 60 days with our thread's subject. Everything else is dropped in memory, never stored.

export interface InboundEnvelope {
  readonly fromEmail: string | null;
  readonly to: readonly string[];
  readonly subject: string;
  /** Message-IDs from In-Reply-To and References, as written (`<id@host>`). */
  readonly references: readonly string[];
  readonly providerThreadId: string | null;
  /** Message-IDs quoted inside a bounce (the original message's headers). */
  readonly bouncedMessageIds: readonly string[];
}

export interface KnownOutreach {
  /** Which of the envelope's referenced Message-IDs are ours. */
  readonly ourMessageIds: ReadonlySet<string>;
  /** Which provider thread ids are ours. */
  readonly ourProviderThreads: ReadonlySet<string>;
  readonly unsubscribeMailto: string | null;
  /** Contacts emailed from this mailbox in the last 60 days → the normalized subjects of those threads. */
  readonly recentContacts: ReadonlyMap<string, readonly string[]>;
}

export type Relevance =
  | { readonly relevant: false }
  | {
      readonly relevant: true;
      readonly reason: 'reference' | 'thread' | 'bounce' | 'unsubscribe_mailto' | 'contact_subject';
      /** Our Message-ID this message answers or bounces, when known. */
      readonly messageId: string | null;
    };

const PREFIX = /^\s*((re|tr|fw|fwd|aw|wg|rv|r)\s*(\[\d+\])?\s*:\s*)+/i;

/** `Re: RE : TR: Fwd:` prefixes and whitespace removed, lower case (subjects compared across replies). */
export function normalizeSubject(subject: string): string {
  return subject.replace(PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export const normalizeMessageId = (value: string): string => {
  const trimmed = value.trim();
  return (trimmed.startsWith('<') ? trimmed : `<${trimmed}>`).toLowerCase();
};

export function relevance(message: InboundEnvelope, known: KnownOutreach): Relevance {
  const ours = (ids: readonly string[]) =>
    ids.map(normalizeMessageId).find((id) => known.ourMessageIds.has(id)) ?? null;
  const bounced = ours(message.bouncedMessageIds);
  if (bounced) return { relevant: true, reason: 'bounce', messageId: bounced };
  // The newest reference first: In-Reply-To, then References from the end.
  const referenced = ours([...message.references].reverse());
  if (referenced) return { relevant: true, reason: 'reference', messageId: referenced };
  if (message.providerThreadId && known.ourProviderThreads.has(message.providerThreadId))
    return { relevant: true, reason: 'thread', messageId: null };
  const mailto = known.unsubscribeMailto?.toLowerCase();
  if (mailto && message.to.some((address) => address.toLowerCase() === mailto))
    return { relevant: true, reason: 'unsubscribe_mailto', messageId: null };
  const from = message.fromEmail?.toLowerCase();
  const subjects = from ? known.recentContacts.get(from) : undefined;
  if (subjects?.includes(normalizeSubject(message.subject)))
    return { relevant: true, reason: 'contact_subject', messageId: null };
  return { relevant: false };
}
