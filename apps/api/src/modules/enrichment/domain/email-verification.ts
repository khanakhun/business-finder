import type { EmailVerificationDetails, EmailVerifierId, VerificationStatus } from '@bf/contracts';

// E-mail verification verdicts (BF-028): what each verifier's answer means as a contact's `verification_status`,
// how long a verdict is trusted, and the optional name-pattern candidates. Pure: adapters parse, this decides.

/** One verifier's verdict on one address. `unknown` is inconclusive: the chain asks the next verifier. */
export interface EmailCheck {
  readonly status: VerificationStatus;
  readonly details: EmailVerificationDetails;
  /** What this check cost (commercial verifiers), counted against enrichment budgets. */
  readonly costUsd: number;
}

export const isConclusive = (check: Pick<EmailCheck, 'status'>): boolean => check.status !== 'unknown';

/** Verifiers that ask about the mailbox itself (DNS only knows whether the domain takes mail). */
export const checksMailbox = (id: EmailCheck['details']['checkedVia']): boolean =>
  id === 'reacher' || id === 'zerobounce';

/**
 * A mail server's politeness bucket is empty (BF-028): nothing was asked; try again in `retryAfterMs`. Thrown by the
 * politeness decorator around verifiers that talk to recipients' mail servers.
 */
export class MailServerBusyError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('The mail server was asked recently; waiting');
    this.name = 'MailServerBusyError';
  }
}

type Reachable = EmailVerificationDetails['reachable'];
const REACHABLE: readonly Reachable[] = ['safe', 'risky', 'invalid', 'unknown'];

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/** Mail providers recognised from MX hosts (shown to users; a hint, not a verdict). */
const MX_PROVIDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)(google|googlemail)\.com$/, 'Google'],
  [/(^|\.)outlook\.com$/, 'Microsoft'],
  [/(^|\.)yahoodns\.net$/, 'Yahoo'],
  [/(^|\.)icloud\.com$/, 'iCloud'],
  [/(^|\.)zoho\.(com|eu)$/, 'Zoho'],
  [/(^|\.)ovh\.net$/, 'OVHcloud'],
  [/(^|\.)(ionos|kundenserver|1and1)\.[a-z.]+$/, 'IONOS'],
  [/(^|\.)gandi\.net$/, 'Gandi'],
  [/(^|\.)orange\.fr$/, 'Orange'],
  [/(^|\.)mimecast\.com$/, 'Mimecast'],
  [/(^|\.)pphosted\.com$/, 'Proofpoint'],
  [/(^|\.)protonmail\.ch$/, 'Proton'],
];

/** The mail provider behind a domain's MX hosts, when it is a well-known one. */
export function mailProviderFromMx(hosts: readonly string[]): string | null {
  for (const host of hosts) {
    const name = host.toLowerCase().replace(/\.$/, '');
    const match = MX_PROVIDERS.find(([pattern]) => pattern.test(name));
    if (match) return match[1];
  }
  return null;
}

/**
 * Reacher (`POST /v1/check_email`) → verdict. Sections that failed come back as `{type, message}` objects instead
 * of their fields, so every field is read leniently. `risky` is refined with what Reacher saw (disposable,
 * catch-all); role accounts stay `risky`.
 */
export function fromReacher(body: unknown): EmailCheck {
  const root = record(body);
  const misc = record(root.misc);
  const mx = record(root.mx);
  const smtp = record(root.smtp);
  const reachable = REACHABLE.includes(root.is_reachable as Reachable)
    ? (root.is_reachable as Reachable)
    : 'unknown';
  const isCatchAll = bool(smtp.is_catch_all);
  const isDisposable = bool(misc.is_disposable);
  const records = Array.isArray(mx.records)
    ? mx.records.filter((r): r is string => typeof r === 'string')
    : [];
  const status: VerificationStatus =
    reachable === 'safe'
      ? 'valid'
      : reachable === 'invalid'
        ? 'invalid'
        : reachable === 'risky'
          ? isDisposable
            ? 'disposable'
            : isCatchAll
              ? 'catch_all'
              : 'risky'
          : 'unknown';
  return {
    status,
    costUsd: 0,
    details: {
      reachable,
      isCatchAll,
      isDisposable,
      isRoleAccount: bool(misc.is_role_account),
      mxAcceptsMail: bool(mx.accepts_mail),
      smtpCanConnect: bool(smtp.can_connect_smtp),
      provider: mailProviderFromMx(records),
      checkedVia: 'reacher',
    },
  };
}

const ZB_STATUS: Record<string, VerificationStatus> = {
  valid: 'valid',
  invalid: 'invalid',
  'catch-all': 'catch_all',
  // A spam trap must never be mailed: as bad as an address that does not exist.
  spamtrap: 'invalid',
  abuse: 'risky',
  do_not_mail: 'risky',
  unknown: 'unknown',
};

/**
 * ZeroBounce (`GET /v2/validate`) → verdict. Only conclusive answers are billed (ZeroBounce does not charge for
 * `unknown`), so `costUsd` is the configured unit cost for those and 0 otherwise.
 */
export function fromZeroBounce(body: unknown, unitCostUsd: number): EmailCheck {
  const root = record(body);
  const raw = typeof root.status === 'string' ? root.status.toLowerCase() : 'unknown';
  const subStatus = typeof root.sub_status === 'string' ? root.sub_status.toLowerCase() : '';
  const isDisposable = subStatus === 'disposable';
  let status = ZB_STATUS[raw] ?? 'unknown';
  if (isDisposable) status = 'disposable';
  const reachable: Reachable =
    status === 'valid'
      ? 'safe'
      : status === 'invalid'
        ? 'invalid'
        : status === 'unknown'
          ? 'unknown'
          : 'risky';
  const mxFound = root.mx_found === true || root.mx_found === 'true';
  const mxKnown = root.mx_found !== undefined && root.mx_found !== null && root.mx_found !== '';
  const provider = typeof root.smtp_provider === 'string' && root.smtp_provider ? root.smtp_provider : null;
  return {
    status,
    costUsd: status === 'unknown' ? 0 : unitCostUsd,
    details: {
      reachable,
      isCatchAll: raw === 'catch-all' || subStatus === 'role_based_catch_all',
      isDisposable,
      isRoleAccount: subStatus.startsWith('role_based'),
      mxAcceptsMail: mxKnown ? mxFound : null,
      smtpCanConnect: null,
      provider: provider?.slice(0, 100) ?? null,
      checkedVia: 'zerobounce',
    },
  };
}

/** What DNS says about a domain's mail (MX records, the RFC 7505 "null MX", an address record). */
export interface DnsMailFacts {
  readonly mx: readonly string[];
  /** `MX 0 .`: the domain says it accepts no mail. */
  readonly nullMx: boolean;
  /** An A/AAAA record (implicit MX, RFC 5321 §5.1) — only looked at without MX records. */
  readonly hasAddress: boolean;
}

/**
 * DNS only (no mailbox check) → verdict: a domain that cannot receive mail makes every address on it `invalid`;
 * otherwise nothing is known about the mailbox (`unknown`, with `mxAcceptsMail`).
 */
export function fromDns(facts: DnsMailFacts): EmailCheck {
  const accepts = !facts.nullMx && (facts.mx.length > 0 || facts.hasAddress);
  return {
    status: accepts ? 'unknown' : 'invalid',
    costUsd: 0,
    details: {
      reachable: accepts ? 'unknown' : 'invalid',
      isCatchAll: null,
      isDisposable: null,
      isRoleAccount: null,
      mxAcceptsMail: accepts,
      smtpCanConnect: null,
      provider: mailProviderFromMx(facts.mx),
      checkedVia: 'dns',
    },
  };
}

/** A disposable domain needs no mailbox check (and none is spent on it). */
export function disposableByClassification(isRoleAccount: boolean): EmailCheck {
  return {
    status: 'disposable',
    costUsd: 0,
    details: {
      reachable: 'risky',
      isCatchAll: null,
      isDisposable: true,
      isRoleAccount,
      mxAcceptsMail: null,
      smtpCanConnect: null,
      provider: null,
      checkedVia: 'classification',
    },
  };
}

/**
 * How long a verdict is reused (mail servers are asked at most once per TTL). Conclusive verdicts — including a
 * permanent `invalid` — last the full TTL; inconclusive ones (greylisting, a server that would not say) back off:
 * 1, 2, 4… days after each consecutive inconclusive check, up to the TTL.
 */
export function verdictTtlDays(
  check: Pick<EmailCheck, 'status'>,
  inconclusiveStreak: number,
  ttlDays: number,
) {
  if (isConclusive(check)) return ttlDays;
  return Math.min(ttlDays, 2 ** Math.max(0, inconclusiveStreak - 1));
}

/** The verifiers of a workspace's chain, in order, that this deployment can use. */
export function chainOrder(
  configured: readonly EmailVerifierId[],
  available: ReadonlySet<EmailVerifierId>,
): EmailVerifierId[] {
  return [...new Set(configured)].filter((id) => available.has(id));
}

const fold = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Name-pattern candidates (feature `emailPatternGuessing`, off by default): `first@`, `first.last@`, `f.last@` on
 * the business's own domain. Only ever checked, never used for outreach unverified (BF-049 decides whether a
 * personal address may be used at all).
 */
export function guessEmailCandidates(personName: string, domain: string): string[] {
  const parts = fold(personName)
    .split(/[^a-z-]+/)
    .map((part) => part.replace(/^-+|-+$/g, ''))
    .filter((part) => part.length >= 2);
  const first = parts[0];
  if (!first || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return [];
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  const locals = last ? [first, `${first}.${last}`, `${first[0]}.${last}`] : [first];
  return [...new Set(locals)].filter((local) => local.length <= 64).map((local) => `${local}@${domain}`);
}
