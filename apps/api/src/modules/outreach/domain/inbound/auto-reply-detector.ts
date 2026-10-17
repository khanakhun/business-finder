// Automatic replies (BF-054): RFC 3834 `Auto-Submitted`, the de-facto `X-Autoreply`/`X-Autorespond` headers,
// `Precedence: auto_reply|bulk|junk`, and out-of-office subjects and phrases in French and English. The return date
// is read from the text when it is written plainly ("back on 12 November", « de retour le 12/11 »); the triage model
// is the fallback.

export interface AutoReplyInput {
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly subject: string;
  readonly text: string;
  /** The reply's date (resolves a year-less return date). */
  readonly receivedAt: Date;
}

export interface AutoReply {
  readonly returnDate: string | null;
  readonly signal: 'header' | 'subject' | 'text';
}

const SUBJECT =
  /(out of (the )?office|automatic reply|auto(matic)?[- ]?reply|autoreply|away from (the )?office|on vacation|absence|absent|réponse automatique|message automatique|en congés?|hors du bureau|abwesenheit)/i;
const TEXT =
  /(i am (currently )?(out of the office|away|on (annual )?leave|on vacation)|i('m| am) out of the office|je suis (actuellement )?(absente?|en congés?|en vacances|en déplacement)|je serai (absente?|de retour))/i;

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  janvier: 1,
  février: 2,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  août: 8,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  décembre: 12,
  decembre: 12,
};

const header = (input: AutoReplyInput, name: string) => input.headers[name]?.[0]?.toLowerCase().trim() ?? '';

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** A return date written after "back/return/retour/until/jusqu'au", resolved to the next occurrence. */
export function returnDate(text: string, receivedAt: Date): string | null {
  const window = text.match(
    /(back|return(ing)?|retour|until|till|jusqu['’]au|à partir du|from|dès le|des le)[^.\n]{0,40}/i,
  )?.[0];
  if (!window) return null;
  const year = receivedAt.getUTCFullYear();
  const resolve = (month: number, day: number, explicitYear?: number) => {
    const candidate = iso(explicitYear ?? year, month, day);
    if (!candidate || explicitYear) return candidate;
    // A date already past this year is next year's.
    return candidate < receivedAt.toISOString().slice(0, 10) ? iso(year + 1, month, day) : candidate;
  };
  const named = window.match(
    /(\d{1,2})(?:st|nd|rd|th|er)?\s+([a-zéû]+)(?:\s+(\d{4}))?|([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i,
  );
  if (named) {
    const [, d1, m1, y1, m2, d2, y2] = named;
    const month = MONTHS[(m1 ?? m2 ?? '').toLowerCase()];
    const day = Number(d1 ?? d2);
    if (month) return resolve(month, day, y1 || y2 ? Number(y1 ?? y2) : undefined);
  }
  const numeric = window.match(/(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?/);
  if (numeric) {
    const [, a, b, y] = numeric;
    // Day first (FR and most of the world); an impossible day/month swaps to month-first (US).
    const [day, month] = Number(b) > 12 ? [Number(b), Number(a)] : [Number(a), Number(b)];
    const fullYear = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : undefined;
    return resolve(month, day, fullYear);
  }
  return null;
}

export function detectAutoReply(input: AutoReplyInput): AutoReply | null {
  const autoSubmitted = header(input, 'auto-submitted');
  const precedence = header(input, 'precedence');
  const byHeader =
    (autoSubmitted !== '' && autoSubmitted !== 'no') ||
    header(input, 'x-autoreply') !== '' ||
    header(input, 'x-autorespond') !== '' ||
    ['auto_reply', 'bulk', 'junk'].includes(precedence);
  const signal = byHeader
    ? 'header'
    : SUBJECT.test(input.subject)
      ? 'subject'
      : TEXT.test(input.text)
        ? 'text'
        : null;
  if (!signal) return null;
  return { returnDate: returnDate(input.text, input.receivedAt), signal };
}
