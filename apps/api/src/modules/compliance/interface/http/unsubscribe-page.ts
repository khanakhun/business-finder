import type { UnsubscribePageModel } from '../../application/unsubscribe.service.ts';

// The unsubscribe page (BF-055): minimal server-rendered HTML that works without JavaScript; a form POSTs the choice
// (GET never unsubscribes). Every dynamic value is escaped; no external resource, no script.

type Lang = 'en' | 'fr';

const STRINGS = {
  en: {
    title: 'Unsubscribe',
    intro: (agency: string) => `You received a message from ${agency}. Choose what should stop:`,
    address: (email: string) => `Do not send any more messages to ${email}`,
    business: 'Stop all contact with my business',
    preview: 'Remove the preview website made for my business',
    confirm: 'Confirm',
    done: (agency: string) => `Done. You won’t receive further messages from ${agency}.`,
    already: 'This address is already unsubscribed. You can still choose more below.',
    unknown:
      'This link is not valid any more. If you still receive messages, reply “stop” and we will remove you.',
    switch: 'Français',
    footer: 'This page stores no cookie.',
  },
  fr: {
    title: 'Se désinscrire',
    intro: (agency: string) => `Vous avez reçu un message de ${agency}. Choisissez ce qui doit s’arrêter :`,
    address: (email: string) => `Ne plus envoyer de message à ${email}`,
    business: 'Ne plus contacter mon entreprise',
    preview: 'Supprimer le site d’aperçu réalisé pour mon entreprise',
    confirm: 'Confirmer',
    done: (agency: string) => `C’est fait. Vous ne recevrez plus de message de ${agency}.`,
    already: 'Cette adresse est déjà désinscrite. Vous pouvez encore choisir d’autres options ci-dessous.',
    unknown:
      'Ce lien n’est plus valide. Si vous recevez encore des messages, répondez « stop » et nous vous retirerons.',
    switch: 'English',
    footer: 'Cette page n’enregistre aucun cookie.',
  },
} as const;

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export const pageLang = (requested: string | undefined, fallback: Lang): Lang =>
  requested === 'fr' || requested === 'en' ? requested : fallback;

function agencyLine(model: UnsubscribePageModel): string {
  const { agencyName, legalName, postalAddress } = model.agency;
  const name = agencyName ?? legalName ?? '';
  const address = postalAddress
    ? [
        postalAddress.line1,
        postalAddress.line2,
        `${postalAddress.postalCode} ${postalAddress.city}`,
        postalAddress.countryCode,
      ]
        .filter(Boolean)
        .join(', ')
    : '';
  return [name, legalName && legalName !== name ? legalName : null, address].filter(Boolean).join(' — ');
}

function layout(lang: Lang, body: string, switchHref: string | null): string {
  const s = STRINGS[lang];
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(s.title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1f2937; --bg: #ffffff; --muted: #6b7280; --accent: #0e7490; --border: #e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e5e7eb; --bg: #111827; --muted: #9ca3af; --accent: #22d3ee; --border: #374151; } }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  fieldset { border: 1px solid var(--border); border-radius: .5rem; padding: 1rem; }
  label { display: flex; gap: .6rem; align-items: flex-start; margin: .5rem 0; }
  button { margin-top: 1rem; font: inherit; padding: .55rem 1.2rem; border-radius: .4rem; border: 0; background: var(--accent); color: #fff; cursor: pointer; }
  .muted { color: var(--muted); font-size: .85rem; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(s.title)}</h1>
${body}
<p class="muted">${switchHref ? `<a href="${escapeHtml(switchHref)}">${escapeHtml(s.switch)}</a> · ` : ''}${escapeHtml(s.footer)}</p>
</main>
</body>
</html>`;
}

export function renderUnknown(lang: Lang): string {
  return layout(lang, `<p>${escapeHtml(STRINGS[lang].unknown)}</p>`, null);
}

export function renderForm(token: string, lang: Lang, model: UnsubscribePageModel): string {
  const s = STRINGS[lang];
  const agency = agencyLine(model) || '—';
  const action = `/u/${encodeURIComponent(token)}?lang=${lang}`;
  const options = [
    `<label><input type="checkbox" name="choice" value="address" checked disabled> <span>${escapeHtml(s.address(model.maskedEmail))}</span></label>`,
    ...(model.hasBusiness
      ? [
          `<label><input type="checkbox" name="choice" value="business"> <span>${escapeHtml(s.business)}</span></label>`,
          `<label><input type="checkbox" name="choice" value="preview"> <span>${escapeHtml(s.preview)}</span></label>`,
        ]
      : []),
  ].join('\n');
  const body = `${model.alreadyUsed ? `<p>${escapeHtml(s.already)}</p>` : ''}
<p>${escapeHtml(s.intro(agency))}</p>
<form method="post" action="${escapeHtml(action)}">
<fieldset>
${options}
</fieldset>
<button type="submit">${escapeHtml(s.confirm)}</button>
</form>`;
  return layout(lang, body, `/u/${encodeURIComponent(token)}?lang=${lang === 'fr' ? 'en' : 'fr'}`);
}

export function renderDone(lang: Lang, model: UnsubscribePageModel): string {
  const name = model.agency.agencyName ?? model.agency.legalName ?? '—';
  return layout(lang, `<p>${escapeHtml(STRINGS[lang].done(name))}</p>`, null);
}
