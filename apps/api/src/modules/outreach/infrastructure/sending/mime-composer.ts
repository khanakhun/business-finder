import MailComposer from 'nodemailer/lib/mail-composer';
import type { MailboxRecord } from '../../application/mailbox/ports.ts';
import type { OutboundRecord } from '../../application/outbound/ports.ts';

// The message as it leaves (BF-052): built from what was queued — subject, text/plain first then a minimal HTML
// alternative, the footer already inside both — plus the identity of the sending mailbox. The headers stored at
// enqueue carry the Message-ID, `X-BF-Outbound-Id`, threading and the RFC 8058 one-click unsubscribe. No tracking
// pixel, no redirected link: what the person previewed is what goes out.

/** Headers the composer sets itself (from the stored ones) rather than passing through. */
const OWN = new Set(['message-id', 'in-reply-to', 'references']);

export async function composeMime(
  message: OutboundRecord,
  mailbox: MailboxRecord,
  options: { readonly date: Date; readonly feedbackId?: string | null },
): Promise<Buffer> {
  if (!message.toEmail) throw new Error('The message has no recipient');
  const stored = message.headers;
  const unsubscribe = stored['List-Unsubscribe'];
  // Fail closed: a message without its one-click unsubscribe never leaves.
  if (!unsubscribe || stored['List-Unsubscribe-Post'] !== 'List-Unsubscribe=One-Click')
    throw new Error('The message has no one-click unsubscribe');
  const passthrough = Object.fromEntries(
    Object.entries(stored).filter(([name]) => !OWN.has(name.toLowerCase())),
  );
  const composer = new MailComposer({
    from: { name: mailbox.displayName, address: mailbox.email },
    to: message.toEmail,
    ...(mailbox.replyTo ? { replyTo: mailbox.replyTo } : {}),
    subject: message.subject,
    date: options.date,
    messageId: message.rfc822MessageId,
    ...(stored['In-Reply-To'] ? { inReplyTo: stored['In-Reply-To'] } : {}),
    ...(stored.References ? { references: stored.References } : {}),
    text: message.bodyText,
    html: message.bodyHtml,
    headers: {
      ...passthrough,
      ...(options.feedbackId ? { 'Feedback-ID': options.feedbackId } : {}),
    },
  });
  return composer.compile().build();
}
