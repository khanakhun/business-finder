import type { CheckOutcome, DnsCheck, DomainCheck, MailboxProviderKind } from '@bf/contracts';
import { dkimKeyBits, evaluateSpf, parseDmarc, type TxtLookup } from './dns-evaluators.ts';
import { presetFor } from './presets.ts';

// A sending domain's authentication checklist (BF-056): each check pass/warn/fail/unknown with what was found, a
// one-line summary and the exact fix (EN/FR). The overall outcome is the readiness gate's: `fail` when SPF or DKIM
// fails or DMARC is missing; `unknown` when DNS did not answer (never `pass` by default).

export interface DnsLookups {
  readonly txt: TxtLookup;
  readonly mx: (domain: string) => Promise<string[] | null>;
}

type Text = { readonly en: string; readonly fr: string };

const check = (
  id: DnsCheck['id'],
  outcome: CheckOutcome,
  found: string | null,
  summary: Text,
  fix: Text | null,
  informational = false,
): DnsCheck => ({ id, outcome, found, summary, fix, informational });

const UNKNOWN: Text = {
  en: 'DNS did not answer in time: checked again later.',
  fr: 'Le DNS n’a pas répondu à temps : nouvelle vérification plus tard.',
};

export async function checkDomain(
  domain: string,
  provider: MailboxProviderKind | 'unknown',
  dns: DnsLookups,
  now: Date,
): Promise<DomainCheck> {
  const mxHosts = await dns.mx(domain);
  const preset = presetFor(provider === 'unknown' ? 'smtp_imap' : provider, mxHosts ?? []);
  const exact = provider === 'gmail' || provider === 'graph';
  const checks: DnsCheck[] = [];

  // MX
  checks.push(
    mxHosts === null
      ? check('mx', 'unknown', null, UNKNOWN, null)
      : mxHosts.length > 0
        ? check(
            'mx',
            'pass',
            mxHosts.join(', '),
            { en: 'The domain receives mail.', fr: 'Le domaine reçoit des e-mails.' },
            null,
          )
        : check(
            'mx',
            'warn',
            null,
            {
              en: 'No MX record: replies to this domain may bounce.',
              fr: 'Aucun enregistrement MX : les réponses à ce domaine risquent d’être rejetées.',
            },
            {
              en: 'Add the MX records your email host gives you.',
              fr: 'Ajoutez les enregistrements MX fournis par votre hébergeur e-mail.',
            },
          ),
  );

  // SPF
  const spf = await evaluateSpf(domain, dns.txt);
  const suggested = preset.spfInclude
    ? `v=spf1 include:${preset.spfInclude} ~all`
    : 'v=spf1 include:<your email host> ~all';
  const spfFix: Text = {
    en: `Publish one TXT record at ${domain}: ${suggested}${spf.record ? ` (merge it with your current record: ${spf.record})` : ''}`,
    fr: `Publiez un seul enregistrement TXT sur ${domain} : ${suggested}${spf.record ? ` (fusionnez-le avec l’enregistrement actuel : ${spf.record})` : ''}`,
  };
  if (spf.unknown && !spf.record) checks.push(check('spf', 'unknown', null, UNKNOWN, null));
  else if (!spf.record)
    checks.push(
      check('spf', 'fail', null, { en: 'No SPF record.', fr: 'Aucun enregistrement SPF.' }, spfFix),
    );
  else if (spf.records > 1)
    checks.push(
      check(
        'spf',
        'fail',
        spf.record,
        {
          en: 'Several SPF records: receivers reject them all.',
          fr: 'Plusieurs enregistrements SPF : les destinataires les rejettent tous.',
        },
        spfFix,
      ),
    );
  else if (spf.lookups > 10)
    checks.push(
      check(
        'spf',
        'fail',
        `${spf.lookups} lookups`,
        {
          en: `The SPF record needs ${spf.lookups} DNS lookups (the limit is 10).`,
          fr: `L’enregistrement SPF demande ${spf.lookups} requêtes DNS (la limite est 10).`,
        },
        {
          en: 'Remove the includes you no longer use, or flatten them.',
          fr: 'Retirez les « include » inutilisés, ou aplatissez-les.',
        },
      ),
    );
  else if (preset.spfInclude && !spf.includes.includes(preset.spfInclude))
    checks.push(
      check(
        'spf',
        exact ? 'fail' : 'warn',
        spf.record,
        { en: `SPF does not authorize ${preset.name}.`, fr: `Le SPF n’autorise pas ${preset.name}.` },
        spfFix,
      ),
    );
  else if (spf.all === '+all' || spf.all === '?all' || !spf.all)
    checks.push(
      check(
        'spf',
        'warn',
        spf.record,
        {
          en: 'SPF ends without ~all or -all: anyone may send as you.',
          fr: 'Le SPF ne se termine pas par ~all ou -all : n’importe qui peut envoyer en votre nom.',
        },
        spfFix,
      ),
    );
  else
    checks.push(
      check(
        'spf',
        'pass',
        spf.record,
        { en: `SPF authorizes ${preset.name}.`, fr: `Le SPF autorise ${preset.name}.` },
        null,
      ),
    );

  // DKIM: the provider's selectors (exact for Google and Microsoft; common ones otherwise).
  let dkim: { selector: string; bits: number | null; revoked: boolean } | null = null;
  let dkimUnknown = false;
  for (const selector of preset.dkimSelectors) {
    const txt = await dns.txt(`${selector}._domainkey.${domain}`);
    if (txt === null) {
      dkimUnknown = true;
      continue;
    }
    const key = dkimKeyBits(txt);
    if (key.record) {
      dkim = { selector, bits: key.bits, revoked: key.revoked };
      break;
    }
  }
  const dkimFix: Text = preset.dkimHow;
  if (!dkim)
    checks.push(
      dkimUnknown
        ? check('dkim', 'unknown', null, UNKNOWN, null)
        : check(
            'dkim',
            exact ? 'fail' : 'warn',
            preset.dkimSelectors.join(', '),
            exact
              ? {
                  en: 'No DKIM key: messages are not signed.',
                  fr: 'Aucune clé DKIM : les messages ne sont pas signés.',
                }
              : {
                  en: 'No DKIM key under the usual selectors (yours may use another one).',
                  fr: 'Aucune clé DKIM sous les sélecteurs habituels (le vôtre peut en utiliser un autre).',
                },
            dkimFix,
          ),
    );
  else if (dkim.revoked)
    checks.push(
      check(
        'dkim',
        'fail',
        dkim.selector,
        { en: 'The DKIM key is revoked (empty).', fr: 'La clé DKIM est révoquée (vide).' },
        dkimFix,
      ),
    );
  else if (dkim.bits !== null && dkim.bits < 1024)
    checks.push(
      check(
        'dkim',
        'fail',
        `${dkim.selector} (${dkim.bits} bits)`,
        {
          en: `The DKIM key is too short (${dkim.bits} bits).`,
          fr: `La clé DKIM est trop courte (${dkim.bits} bits).`,
        },
        dkimFix,
      ),
    );
  else if (dkim.bits !== null && dkim.bits < 2048)
    checks.push(
      check(
        'dkim',
        'warn',
        `${dkim.selector} (${dkim.bits} bits)`,
        {
          en: 'DKIM signs with a 1024-bit key: 2048 is recommended.',
          fr: 'DKIM signe avec une clé de 1024 bits : 2048 est recommandé.',
        },
        dkimFix,
      ),
    );
  else
    checks.push(
      check(
        'dkim',
        'pass',
        `${dkim.selector}${dkim.bits ? ` (${dkim.bits} bits)` : ''}`,
        { en: 'Messages are signed with DKIM.', fr: 'Les messages sont signés avec DKIM.' },
        null,
      ),
    );

  // DMARC
  const dmarcTxt = await dns.txt(`_dmarc.${domain}`);
  const dmarcFix: Text = {
    en: `Publish a TXT record at _dmarc.${domain}: v=DMARC1; p=none; rua=mailto:dmarc@${domain} — then move to p=quarantine once reports are clean.`,
    fr: `Publiez un enregistrement TXT sur _dmarc.${domain} : v=DMARC1; p=none; rua=mailto:dmarc@${domain} — puis passez à p=quarantine quand les rapports sont propres.`,
  };
  if (dmarcTxt === null) checks.push(check('dmarc', 'unknown', null, UNKNOWN, null));
  else {
    const dmarc = parseDmarc(dmarcTxt);
    if (!dmarc.record || !dmarc.policy)
      checks.push(
        check(
          'dmarc',
          'fail',
          dmarc.record,
          { en: 'No DMARC record.', fr: 'Aucun enregistrement DMARC.' },
          dmarcFix,
        ),
      );
    else if (dmarc.policy === 'none' || !dmarc.rua)
      checks.push(
        check(
          'dmarc',
          'warn',
          dmarc.record,
          dmarc.policy === 'none'
            ? { en: 'DMARC only monitors (p=none).', fr: 'DMARC ne fait que surveiller (p=none).' }
            : { en: 'DMARC sends no reports (no rua).', fr: 'DMARC n’envoie pas de rapports (pas de rua).' },
          dmarcFix,
        ),
      );
    else
      checks.push(
        check(
          'dmarc',
          'pass',
          dmarc.record,
          { en: `DMARC policy ${dmarc.policy}.`, fr: `Politique DMARC ${dmarc.policy}.` },
          null,
        ),
      );
  }

  // Informational: MTA-STS, TLS-RPT, BIMI.
  const info = async (id: 'mta_sts' | 'tls_rpt' | 'bimi', name: string, prefix: RegExp, label: Text) => {
    const txt = await dns.txt(name);
    const record = txt?.find((value) => prefix.test(value.trim())) ?? null;
    checks.push(
      check(
        id,
        txt === null ? 'unknown' : record ? 'pass' : 'warn',
        record,
        record ? label : { en: `No ${label.en}.`, fr: `Pas de ${label.fr}.` },
        null,
        true,
      ),
    );
  };
  await info('mta_sts', `_mta-sts.${domain}`, /^v=STSv1/i, { en: 'MTA-STS policy', fr: 'politique MTA-STS' });
  await info('tls_rpt', `_smtp._tls.${domain}`, /^v=TLSRPTv1/i, { en: 'TLS reporting', fr: 'rapports TLS' });
  await info('bimi', `default._bimi.${domain}`, /^v=BIMI1/i, { en: 'BIMI logo', fr: 'logo BIMI' });

  const blocking = checks.filter((item) => !item.informational);
  const outcome: CheckOutcome =
    readinessBlockers(checks).length > 0
      ? 'fail'
      : blocking.some((item) => item.outcome === 'unknown')
        ? 'unknown'
        : blocking.some((item) => item.outcome === 'warn' || item.outcome === 'fail')
          ? 'warn'
          : 'pass';
  return { domain, provider, outcome, checks, checkedAt: now.toISOString() };
}

/** What stops automatic sending (BF-056 readiness gate). */
export function readinessBlockers(checks: readonly DnsCheck[]): string[] {
  const outcome = (id: DnsCheck['id']) => checks.find((item) => item.id === id)?.outcome;
  return [
    ...(outcome('spf') === 'fail' ? ['spf_fail'] : []),
    ...(outcome('dkim') === 'fail' ? ['dkim_fail'] : []),
    ...(outcome('dmarc') === 'fail' ? ['dmarc_missing'] : []),
  ];
}
