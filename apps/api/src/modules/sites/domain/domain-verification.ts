import type { SiteDomain, SiteDomainStatus } from '@bf/contracts';

// Custom domain verification (BF-062, State Machine): `pending_dns` → `verifying` (records seen, not all right)
// → `verified` (TXT token and routing records match) → `active` (served live) ; `failed` after 72 h without a
// match; `removed` by a person. A name is checked with exponential backoff (5 min doubling up to 6 h) and on
// demand. The TXT record proves control; the routing record makes the traffic and the certificate reach us.

export const VERIFY_WINDOW_MS = 72 * 3_600_000;
const FIRST_DELAY_MS = 5 * 60_000;
const MAX_DELAY_MS = 6 * 3_600_000;

/** `www.` names redirect to their apex; two labels is an apex; anything longer a subdomain. */
export function classifyHostname(hostname: string): { kind: 'apex' | 'subdomain' | 'www'; apex: string } {
  const labels = hostname.split('.');
  if (labels[0] === 'www' && labels.length === 3) return { kind: 'www', apex: labels.slice(1).join('.') };
  // DECISION(BF-062): no public suffix list here — `salon.co.uk` reads as a subdomain (CNAME instructions), which
  // works for most registrars; the wizard lets the person see the records before adding them.
  return labels.length === 2 ? { kind: 'apex', apex: hostname } : { kind: 'subdomain', apex: hostname };
}

/** Where the TXT token goes: the apex for an apex and its `www`, the name itself for a subdomain. */
export const verificationName = (hostname: string) => {
  const { kind, apex } = classifyHostname(hostname);
  return `_bf-verify.${kind === 'subdomain' ? hostname : apex}`;
};

export interface Ingress {
  /** `cname.<sites domain>`. */
  readonly cnameTarget: string;
  /** The ingress's public IPs (A/AAAA of an apex). */
  readonly ips: readonly string[];
}

export function expectedRecords(
  domain: { hostname: string; kind: SiteDomain['kind']; token: string },
  ingress: Ingress,
): SiteDomain['records'] {
  const records: SiteDomain['records'] = [
    { type: 'TXT', name: verificationName(domain.hostname), value: domain.token },
  ];
  if (domain.kind === 'apex')
    for (const ip of ingress.ips)
      records.push({ type: ip.includes(':') ? 'AAAA' : 'A', name: domain.hostname, value: ip });
  else records.push({ type: 'CNAME', name: domain.hostname, value: ingress.cnameTarget });
  return records;
}

export interface DnsAnswers {
  readonly txt: readonly string[];
  readonly cname: readonly string[];
  readonly a: readonly string[];
  readonly aaaa: readonly string[];
}

const strip = (name: string) => name.toLowerCase().replace(/\.$/, '');

/** The check of each expected record against what DNS answers (CNAME flattening counts: the ingress IPs). */
export function evaluateDns(
  domain: { hostname: string; kind: SiteDomain['kind']; token: string },
  ingress: Ingress,
  answers: DnsAnswers,
): NonNullable<SiteDomain['report']>['checks'] {
  const checks: NonNullable<SiteDomain['report']>['checks'] = [
    {
      type: 'TXT',
      name: verificationName(domain.hostname),
      expected: domain.token,
      found: [...answers.txt],
      ok: answers.txt.includes(domain.token),
    },
  ];
  const ips = [...answers.a, ...answers.aaaa];
  const pointsAtIngress =
    ingress.ips.length > 0 && ips.length > 0 && ips.every((ip) => ingress.ips.includes(ip));
  if (domain.kind === 'apex')
    checks.push({
      type: 'A',
      name: domain.hostname,
      expected: ingress.ips.join(', '),
      found: ips,
      ok: pointsAtIngress,
    });
  else
    checks.push({
      type: 'CNAME',
      name: domain.hostname,
      expected: ingress.cnameTarget,
      found: answers.cname.length ? answers.cname.map(strip) : ips,
      ok: answers.cname.map(strip).includes(strip(ingress.cnameTarget)) || pointsAtIngress,
    });
  return checks;
}

/** The status after a check, and when to look again. */
export function nextState(
  checks: NonNullable<SiteDomain['report']>['checks'],
  domain: { attempts: number; createdAt: Date },
  now: Date,
): { status: SiteDomainStatus; nextCheckAt: Date } {
  if (checks.every((check) => check.ok)) return { status: 'verified', nextCheckAt: now };
  if (now.getTime() - domain.createdAt.getTime() > VERIFY_WINDOW_MS)
    return { status: 'failed', nextCheckAt: new Date(now.getTime() + MAX_DELAY_MS) };
  const delay = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** domain.attempts);
  return {
    status: checks.some((check) => check.found.length > 0) ? 'verifying' : 'pending_dns',
    nextCheckAt: new Date(now.getTime() + delay),
  };
}
