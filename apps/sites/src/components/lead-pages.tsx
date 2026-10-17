import type { SiteLocale } from '@bf/site-schema';
import type { LeadPage } from '@/lib/lead-pages.ts';
import type { LeadStrings } from '@/lib/lead-strings.ts';
import { LeadFormEnhancer } from './lead-form-enhancer.tsx';

// The preview's lead pages (BF-048), plain server-rendered HTML forms (they work without JavaScript; the enhancer adds
// the proof of work): "this is my business", "don't contact me" and the agency's privacy notice.

export interface LeadPageProps {
  readonly page: LeadPage;
  readonly locale: SiteLocale;
  readonly strings: LeadStrings;
  readonly business: string;
  readonly agency: string;
  readonly agencyUrl: string | null;
  /** Where forms post, and the proof-of-work challenge (null: lead capture is off). */
  readonly endpoints: { readonly submit: string; readonly challenge: string } | null;
  readonly hidden: Readonly<Record<string, string>>;
  /** `?sent=` after a plain form post. */
  readonly sent: string | undefined;
  readonly homeHref: string;
  readonly privacyHref: string;
}

function Hidden({ fields }: { fields: Readonly<Record<string, string>> }) {
  return (
    <>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {/* Honeypot: hidden from people and assistive technology; filled by naive bots. */}
      <div
        aria-hidden="true"
        style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}
      >
        <label htmlFor="lead-hp">Leave empty</label>
        <input id="lead-hp" name="hp" tabIndex={-1} autoComplete="off" />
      </div>
    </>
  );
}

function Field({
  id,
  label,
  optional,
  children,
}: {
  id: string;
  label: string;
  optional?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="bf-field">
      <label className="bf-label" htmlFor={id}>
        {label} {optional ? <span className="bf-muted font-normal">({optional})</span> : null}
      </label>
      {children}
    </div>
  );
}

export function LeadPageView(props: LeadPageProps) {
  const { strings: s, business, agency } = props;
  return (
    <main id="main" className="bf-container mx-auto max-w-2xl py-16">
      <p className="mb-8 text-sm">
        <a href={props.homeHref}>← {s.backToPreview}</a>
      </p>
      {props.page === 'claim' ? (
        <Claim {...props} />
      ) : props.page === 'opt-out' ? (
        <OptOut {...props} />
      ) : null}
      {props.page === 'privacy' ? (
        <article className="space-y-4">
          <h1 className="bf-h2">{s.privacyTitle(agency)}</h1>
          {s.privacyBody(agency).map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {props.agencyUrl ? (
            <p>
              <a href={props.agencyUrl} rel="noopener">
                {agency}
              </a>
            </p>
          ) : null}
          <p className="bf-muted text-sm">{business}</p>
          <Rights {...props} />
        </article>
      ) : null}
    </main>
  );
}

function Claim(props: LeadPageProps) {
  const { strings: s, business, agency } = props;
  if (props.sent === 'lead.received')
    return (
      <section className="space-y-4" role="status">
        <h1 className="bf-h2">{s.claimSent}</h1>
        <p>{s.claimNext(agency)}</p>
      </section>
    );
  return (
    <section className="space-y-6">
      <h1 className="bf-h2">{s.claimTitle(business)}</h1>
      <p>{s.claimIntro(agency, business)}</p>
      {props.endpoints ? (
        <form id="lead-claim" method="post" action={props.endpoints.submit} className="grid gap-5">
          <Hidden fields={props.hidden} />
          <Field id="lead-name" label={s.name}>
            <input
              id="lead-name"
              name="name"
              className="bf-input"
              autoComplete="name"
              maxLength={120}
              required
            />
          </Field>
          <Field id="lead-phone" label={s.phone} optional={s.optional}>
            <input
              id="lead-phone"
              name="phone"
              type="tel"
              className="bf-input"
              autoComplete="tel"
              maxLength={40}
            />
          </Field>
          <Field id="lead-whatsapp" label={s.whatsapp} optional={s.optional}>
            <input id="lead-whatsapp" name="whatsapp" type="tel" className="bf-input" maxLength={40} />
          </Field>
          <Field id="lead-email" label={s.email} optional={s.optional}>
            <input
              id="lead-email"
              name="email"
              type="email"
              className="bf-input"
              autoComplete="email"
              maxLength={254}
            />
          </Field>
          <Field id="lead-channel" label={s.preferredChannel} optional={s.optional}>
            <select id="lead-channel" name="preferredChannel" className="bf-input" defaultValue="">
              <option value="">—</option>
              <option value="phone">{s.channels.phone}</option>
              <option value="whatsapp">{s.channels.whatsapp}</option>
              <option value="email">{s.channels.email}</option>
            </select>
          </Field>
          <Field id="lead-time" label={s.preferredTime} optional={s.optional}>
            <input id="lead-time" name="preferredTime" className="bf-input" maxLength={120} />
          </Field>
          <Field id="lead-message" label={s.message} optional={s.optional}>
            <textarea id="lead-message" name="message" rows={4} className="bf-input" maxLength={2000} />
          </Field>
          <label className="flex items-start gap-2 text-sm" htmlFor="lead-consent">
            <input id="lead-consent" name="consent" type="checkbox" value="on" required className="mt-1" />
            <span>
              {s.consent(agency)} <a href={props.privacyHref}>{s.privacyLink}</a>
            </span>
          </label>
          <div>
            <button type="submit" className="bf-btn bf-btn-primary">
              {s.send}
            </button>
          </div>
          <LeadFormEnhancer
            formId="lead-claim"
            challengeUrl={props.endpoints.challenge}
            sendingLabel={s.sending}
          />
        </form>
      ) : null}
    </section>
  );
}

function OptOut(props: LeadPageProps) {
  const { strings: s, business, agency } = props;
  if (props.sent === 'optout.received')
    return (
      <section className="space-y-4" role="status">
        <h1 className="bf-h2">{s.optOutSent}</h1>
        <p>{s.optOutWhat}</p>
      </section>
    );
  return (
    <section className="space-y-6">
      <h1 className="bf-h2">{s.optOutTitle}</h1>
      <p>{s.optOutIntro(agency, business)}</p>
      <p className="bf-muted text-sm">{s.optOutWhat}</p>
      {props.endpoints ? (
        <form id="lead-opt-out" method="post" action={props.endpoints.submit} className="grid gap-5">
          <Hidden fields={props.hidden} />
          <label className="flex items-start gap-2" htmlFor="lead-stop">
            <input id="lead-stop" type="checkbox" checked disabled className="mt-1" />
            <span>{s.stopContact}</span>
          </label>
          <label className="flex items-start gap-2" htmlFor="lead-remove">
            <input
              id="lead-remove"
              name="removePreview"
              type="checkbox"
              value="on"
              defaultChecked
              className="mt-1"
            />
            <span>{s.removePreview}</span>
          </label>
          <Field id="lead-reason" label={s.reason} optional={s.optional}>
            <textarea id="lead-reason" name="reason" rows={3} className="bf-input" maxLength={500} />
          </Field>
          <Field id="lead-optout-email" label={s.email} optional={s.optional}>
            <input
              id="lead-optout-email"
              name="email"
              type="email"
              className="bf-input"
              autoComplete="email"
              maxLength={254}
            />
          </Field>
          <p className="text-sm">
            <a href={props.privacyHref}>{s.privacyLink}</a>
          </p>
          <div>
            <button type="submit" className="bf-btn bf-btn-primary">
              {s.optOutConfirm}
            </button>
          </div>
          <LeadFormEnhancer
            formId="lead-opt-out"
            challengeUrl={props.endpoints.challenge}
            sendingLabel={s.sending}
          />
        </form>
      ) : null}
    </section>
  );
}

const DSR_TYPES = ['access', 'erasure', 'objection', 'rectification', 'restriction'] as const;

/** "Exercise your rights" (BF-055): a plain form to the API; works without JavaScript. */
function Rights(props: LeadPageProps) {
  const { strings: s, agency } = props;
  if (!props.endpoints || !props.hidden.siteToken) return null;
  if (props.sent === 'dsr')
    return (
      <section className="space-y-2 pt-6" role="status">
        <h2 className="bf-h3">{s.rightsTitle}</h2>
        <p>{s.rightsSent(agency)}</p>
      </section>
    );
  const action = props.endpoints.submit.replace(/\/leads$/, '/dsr');
  return (
    <section className="space-y-4 pt-6">
      <h2 className="bf-h3">{s.rightsTitle}</h2>
      <p>{s.rightsIntro(agency)}</p>
      <form method="post" action={action} className="grid gap-4">
        <input type="hidden" name="siteToken" value={props.hidden.siteToken} />
        <Field id="dsr-type" label={s.rightsType}>
          <select id="dsr-type" name="type" className="bf-input" defaultValue="access">
            {DSR_TYPES.map((type) => (
              <option key={type} value={type}>
                {s.rightsTypes[type]}
              </option>
            ))}
          </select>
        </Field>
        <Field id="dsr-email" label={s.email}>
          <input
            id="dsr-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="bf-input"
          />
        </Field>
        <Field id="dsr-name" label={s.name} optional={s.optional}>
          <input id="dsr-name" name="name" autoComplete="name" maxLength={200} className="bf-input" />
        </Field>
        <Field id="dsr-message" label={s.message} optional={s.optional}>
          <textarea id="dsr-message" name="message" rows={3} maxLength={2000} className="bf-input" />
        </Field>
        <div>
          <button type="submit" className="bf-btn bf-btn-primary">
            {s.rightsSend}
          </button>
        </div>
      </form>
    </section>
  );
}
