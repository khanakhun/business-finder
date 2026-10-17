import { createPublicKey } from 'node:crypto';

// DNS authentication evaluators (BF-056), pure but for the TXT lookup they are given: SPF (one record, the provider's
// include, at most 10 DNS-querying mechanisms counted recursively, the `all` qualifier), DMARC (policy, reports,
// alignment) and DKIM (the key's size). A lookup that fails says `unknown`, never `pass`.

export type TxtLookup = (name: string) => Promise<string[] | null>;

export interface SpfResult {
  readonly record: string | null;
  readonly records: number;
  readonly lookups: number;
  readonly includes: string[];
  readonly all: string | null;
  readonly unknown: boolean;
}

const LOOKUP_MECHANISMS = /^[+~?-]?(include:|a\b|a:|a\/|mx\b|mx:|mx\/|ptr\b|ptr:|exists:)|^redirect=/i;
const MAX_DEPTH = 10;

export function spfRecords(txt: readonly string[]): string[] {
  return txt.filter((value) => /^v=spf1(\s|$)/i.test(value.trim()));
}

/** Evaluates a domain's SPF, following include/redirect to count lookups (RFC 7208 limit: 10). */
export async function evaluateSpf(domain: string, lookup: TxtLookup): Promise<SpfResult> {
  const txt = await lookup(domain);
  if (txt === null) return { record: null, records: 0, lookups: 0, includes: [], all: null, unknown: true };
  const records = spfRecords(txt);
  const record = records[0] ?? null;
  if (!record) return { record: null, records: 0, lookups: 0, includes: [], all: null, unknown: false };
  const includes: string[] = [];
  let lookups = 0;
  let unknown = false;
  const walk = async (value: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const term of value.trim().split(/\s+/).slice(1)) {
      if (!LOOKUP_MECHANISMS.test(term)) continue;
      lookups++;
      const target = term.match(/^[+~?-]?include:(.+)$/i)?.[1] ?? term.match(/^redirect=(.+)$/i)?.[1];
      if (!target) continue;
      if (depth === 0) includes.push(target.toLowerCase());
      const nested = await lookup(target);
      if (nested === null) {
        unknown = true;
        continue;
      }
      const child = spfRecords(nested)[0];
      if (child) await walk(child, depth + 1);
    }
  };
  await walk(record, 0);
  const all = record.match(/\s([+~?-]?)all\b/i);
  return {
    record,
    records: records.length,
    lookups,
    includes,
    all: all ? `${all[1] || '+'}all` : null,
    unknown,
  };
}

export interface DmarcResult {
  readonly record: string | null;
  readonly policy: 'none' | 'quarantine' | 'reject' | null;
  readonly rua: boolean;
  readonly adkim: 'r' | 's';
  readonly aspf: 'r' | 's';
}

export function parseDmarc(txt: readonly string[]): DmarcResult {
  const record = txt.find((value) => /^v=DMARC1(\s*;|$)/i.test(value.trim())) ?? null;
  const tag = (name: string) =>
    record
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.toLowerCase().startsWith(`${name}=`))
      ?.slice(name.length + 1)
      .trim()
      .toLowerCase() ?? null;
  const policy = tag('p');
  return {
    record,
    policy: policy === 'none' || policy === 'quarantine' || policy === 'reject' ? policy : null,
    rua: !!tag('rua'),
    adkim: tag('adkim') === 's' ? 's' : 'r',
    aspf: tag('aspf') === 's' ? 's' : 'r',
  };
}

/** The RSA key size of a DKIM record (`p=` base64 SubjectPublicKeyInfo); null when missing or unreadable. */
export function dkimKeyBits(txt: readonly string[]): {
  record: string | null;
  bits: number | null;
  revoked: boolean;
} {
  const record = txt.join('').trim();
  if (!/(^|;)\s*p=/i.test(record)) return { record: null, bits: null, revoked: false };
  const p = record.match(/(?:^|;)\s*p=([^;]*)/i)?.[1]?.replace(/\s+/g, '') ?? '';
  if (!p) return { record, bits: null, revoked: true };
  try {
    const key = createPublicKey({ key: Buffer.from(p, 'base64'), format: 'der', type: 'spki' });
    return { record, bits: key.asymmetricKeyDetails?.modulusLength ?? null, revoked: false };
  } catch {
    return { record, bits: null, revoked: false };
  }
}
