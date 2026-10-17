// Delivery status notifications (BF-054, RFC 3464 / RFC 3463). A standard DSN is `multipart/report;
// report-type=delivery-status` with a `message/delivery-status` part (per-recipient Action, Status, Diagnostic-Code)
// and the original message or its headers. Providers also send non-standard bounces (Gmail, Outlook, hosting
// panels): recognized by sender and subject, the status and the original Message-ID found in the text.

export interface MailPart {
  readonly contentType: string;
  readonly content: string;
}

export interface DsnInput {
  readonly contentType: string;
  readonly fromEmail: string | null;
  readonly subject: string;
  readonly text: string;
  readonly parts: readonly MailPart[];
}

export interface Dsn {
  /** `failed` (bounce), `delayed`, `delivered`, `relayed`, `expanded`. */
  readonly action: string;
  /** Enhanced status code, e.g. `5.1.1`. */
  readonly status: string | null;
  readonly permanent: boolean;
  readonly recipient: string | null;
  readonly diagnostic: string | null;
  /** The bounced message's Message-ID, when found. */
  readonly originalMessageId: string | null;
  readonly standard: boolean;
}

const STATUS = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;
const MESSAGE_ID = /^message-id:\s*(<[^>\s]+>)/im;
const BOUNCE_SENDER =
  /^(mailer-daemon|postmaster|mail-delivery|maildelivery|bounce|bounces|no-?reply-?bounce)\b/i;
const BOUNCE_SUBJECT =
  /(undeliver|delivery (status notification|has failed|failure)|mail delivery (failed|subsystem)|returned mail|failure notice|non remis|non distribu|échec de (la )?(remise|distribution)|message (not|non) delivered|rejected)/i;

function field(block: string, name: string): string | null {
  const match = block.match(new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, 'im'));
  return match?.[1]?.replace(/\r?\n[ \t]+/g, ' ').trim() ?? null;
}

const recipientOf = (value: string | null) =>
  value
    ?.replace(/^rfc822;\s*/i, '')
    .trim()
    .toLowerCase() ?? null;

export function parseDsn(input: DsnInput): Dsn | null {
  const report = /multipart\/report/i.test(input.contentType) && /delivery-status/i.test(input.contentType);
  const status = input.parts.find((part) => /message\/(global-)?delivery-status/i.test(part.contentType));
  const original =
    input.parts.find((part) => /(text\/rfc822-headers|message\/(global-)?rfc822)/i.test(part.contentType))
      ?.content ?? '';
  if (report && status) {
    // Per-recipient fields follow the per-message block (separated by a blank line); the first recipient counts.
    const blocks = status.content.split(/\r?\n\r?\n/);
    const recipientBlock =
      blocks.find((block) => /^(final|original)-recipient:/im.test(block)) ?? status.content;
    const code = field(recipientBlock, 'Status');
    const action = (field(recipientBlock, 'Action') ?? 'failed').toLowerCase();
    return {
      action,
      status: code?.match(STATUS)?.[0] ?? null,
      permanent: action === 'failed' && (code?.startsWith('5') ?? true),
      recipient: recipientOf(
        field(recipientBlock, 'Final-Recipient') ?? field(recipientBlock, 'Original-Recipient'),
      ),
      diagnostic: field(recipientBlock, 'Diagnostic-Code')?.slice(0, 500) ?? null,
      originalMessageId: original.match(MESSAGE_ID)?.[1] ?? input.text.match(MESSAGE_ID)?.[1] ?? null,
      standard: true,
    };
  }
  // Non-standard bounces: a bounce sender or a bounce subject, with a status code or a failure wording.
  const sender = input.fromEmail?.split('@')[0] ?? '';
  if (!BOUNCE_SENDER.test(sender) && !BOUNCE_SUBJECT.test(input.subject)) return null;
  const body = [input.text, ...input.parts.map((part) => part.content)].join('\n');
  const code = body.match(STATUS)?.[0] ?? null;
  const hardWording =
    /(does not exist|doesn't exist|no such user|user unknown|unknown user|address rejected|mailbox unavailable|n'existe pas|introuvable|adresse (invalide|inconnue))/i.test(
      body,
    );
  if (!code && !hardWording && !BOUNCE_SUBJECT.test(input.subject)) return null;
  const temporary = code?.startsWith('4') ?? false;
  return {
    action: temporary ? 'delayed' : 'failed',
    status: code,
    permanent: !temporary && (code?.startsWith('5') || hardWording),
    recipient: body.match(/<?([^\s<>"']+@[^\s<>"']+\.[a-z]{2,})>?/i)?.[1]?.toLowerCase() ?? null,
    diagnostic: body.match(/(diagnostic[- ]code|remote server returned|error)[^\n]{0,300}/i)?.[0] ?? null,
    originalMessageId: body.match(MESSAGE_ID)?.[1] ?? null,
    standard: false,
  };
}
