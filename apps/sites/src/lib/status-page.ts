const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A minimal, self-contained status page (unknown site, ended preview): no script, inline styles only, every text
 * escaped. Route handlers answer with it so the status code is the real one (404, 410).
 */
export function statusPage(input: {
  readonly lang: string;
  readonly title: string;
  readonly body: string;
  readonly link?: { readonly href: string; readonly label: string } | undefined;
}): string {
  const link = input.link
    ? `<p><a href="${escapeHtml(input.link.href)}" rel="noopener">${escapeHtml(input.link.label)}</a></p>`
    : '';
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(input.lang)}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(input.title)}</title>`,
    '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.6 system-ui,sans-serif;',
    'color:#1f2937;background:#f8fafc}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.6rem;',
    'margin:0 0 .75rem}a{color:#0f766e;font-weight:600}</style></head>',
    `<body><main><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.body)}</p>${link}</main></body></html>`,
  ].join('');
}

/** The policy of a status page: nothing but its own inline style. */
export const STATUS_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
