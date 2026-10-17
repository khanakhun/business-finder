import type { LegalStrings } from '@/lib/legal-strings.ts';
import type { SiteLegal } from '@/lib/live-pages.ts';

// A live site's legal notice and privacy notice (BF-062): the business as publisher and controller, the agency as
// host and processor, from the legal profile only. A missing profile says the page is being completed.

interface Props {
  readonly page: 'legal' | 'privacy';
  readonly legal: SiteLegal | null;
  readonly business: string;
  readonly strings: LegalStrings;
  readonly homeHref: string;
  readonly locale: string;
}

function Row({ label, value }: { readonly label: string; readonly value: string | null }) {
  if (!value) return null;
  return (
    <div className="grid gap-1 sm:grid-cols-[14rem_1fr]">
      <dt className="font-medium">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function LegalPageView({ page, legal, business, strings: s, homeHref, locale }: Props) {
  const updated = legal
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(legal.updatedAt))
    : null;
  return (
    <main id="main" className="bf-container mx-auto max-w-2xl space-y-8 py-16">
      <p className="text-sm">
        <a href={homeHref}>← {s.backHome}</a>
      </p>
      <h1 className="bf-h2">{page === 'legal' ? s.legalTitle : s.privacyTitle}</h1>
      {!legal ? (
        <p>{s.missing}</p>
      ) : page === 'legal' ? (
        <>
          <section className="space-y-3">
            <h2 className="bf-h3">{s.publisher}</h2>
            <dl className="space-y-2">
              <Row label={s.legalName} value={legal.businessLegalName} />
              <Row label={s.legalForm} value={legal.legalForm} />
              <Row label={s.registration} value={legal.registration} />
              <Row label={s.vat} value={legal.vatNumber} />
              <Row label={s.address} value={legal.address} />
              <Row label={s.phone} value={legal.phone} />
              <Row label={s.email} value={legal.email} />
              <Row label={s.director} value={legal.publicationDirector} />
            </dl>
          </section>
          <section className="space-y-3">
            <h2 className="bf-h3">{s.host}</h2>
            <p>{s.hostIntro(legal.hostName)}</p>
            <dl className="space-y-2">
              <Row label={s.address} value={legal.hostAddress} />
            </dl>
            {legal.hostUrl ? (
              <p>
                <a href={legal.hostUrl} rel="noopener">
                  {legal.hostName}
                </a>
              </p>
            ) : null}
          </section>
          <section className="space-y-3">
            <h2 className="bf-h3">{s.ip}</h2>
            <p>{s.ipBody(business)}</p>
          </section>
          <section className="space-y-3">
            <h2 className="bf-h3">{s.contact}</h2>
            <p>{s.contactBody(legal.email)}</p>
          </section>
        </>
      ) : (
        <>
          {[
            [s.controllerTitle, s.controllerBody(legal.businessLegalName)],
            [s.processorTitle, s.processorBody(legal.hostName)],
            [s.purposeTitle, s.purposeBody],
            [s.basisTitle, s.basisBody],
            [s.retentionTitle, s.retentionBody],
            [s.rightsTitle, s.rightsBody(legal.email)],
            [s.cookiesTitle, s.cookiesBody],
          ].map(([title, body]) => (
            <section key={title} className="space-y-2">
              <h2 className="bf-h3">{title}</h2>
              <p>{body}</p>
            </section>
          ))}
          {legal.dpoContact ? <p>{s.dpo(legal.dpoContact)}</p> : null}
        </>
      )}
      {updated ? <p className="bf-muted text-sm">{s.updated(updated)}</p> : null}
    </main>
  );
}

/** The legal links under a live site's own footer. */
export function LegalLinks({
  prefix,
  strings: s,
}: {
  readonly prefix: string;
  readonly strings: LegalStrings;
}) {
  return (
    <nav aria-label={s.legalTitle} className="bf-container mx-auto flex gap-4 py-4 text-sm">
      <a href={`${prefix}/legal`}>{s.footerLegal}</a>
      <a href={`${prefix}/privacy`}>{s.footerPrivacy}</a>
    </nav>
  );
}
