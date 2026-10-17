// The email renderer (BF-051, Template Method): markdown body → canonical text/plain and a minimal HTML alternative
// (paragraphs, lists, emphasis, links — no images, no styles, no tracking), the mailbox signature, then the
// deterministic footer. The subject is single-line text.

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

const MD_LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g;

/** Markdown → plain text: emphasis dropped, `[label](url)` → `label: url` (the URL alone when they match). */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(MD_LINK, (_m, label: string, url: string) => (label === url ? url : `${label}: ${url}`))
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[*+]\s+/gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inlineHtml(text: string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(MD_LINK)) {
    out += escapeHtml(text.slice(last, match.index));
    out += `<a href="${escapeHtml(match[2] as string)}">${escapeHtml(match[1] as string)}</a>`;
    last = (match.index ?? 0) + match[0].length;
  }
  out += escapeHtml(text.slice(last));
  // Bare URLs (outside an anchor) become links too.
  out = out.replace(
    /(^|[\s(])(https?:\/\/[^\s<]+)/g,
    (_m, lead: string, url: string) => `${lead}<a href="${url}">${url}</a>`,
  );
  return out
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

/** Markdown → minimal HTML (a fragment). */
export function markdownToHtml(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((line) => /^\s*[-*+]\s+/.test(line)))
        return `<ul>${lines.map((line) => `<li>${inlineHtml(line.replace(/^\s*[-*+]\s+/, ''))}</li>`).join('')}</ul>`;
      return `<p>${lines.map((line) => inlineHtml(line.replace(/^#{1,6}\s+/, ''))).join('<br>')}</p>`;
    })
    .join('\n');
}

export interface RenderInput {
  readonly subject: string;
  readonly bodyMd: string;
  readonly signatureMd: string;
  readonly footer: readonly string[];
  readonly locale: 'en' | 'fr';
}

export function renderEmail(input: RenderInput): { subject: string; text: string; html: string } {
  const signature = input.signatureMd.trim();
  const text = [
    markdownToText(input.bodyMd),
    signature ? markdownToText(signature) : null,
    `--\n${input.footer.join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const html = `<!doctype html><html lang="${input.locale}"><head><meta charset="utf-8"></head><body>
${markdownToHtml(input.bodyMd)}
${signature ? markdownToHtml(signature) : ''}
<hr>
<p style="font-size:12px;color:#666">${input.footer.map((line) => inlineHtml(line)).join('<br>')}</p>
</body></html>`;
  return { subject: input.subject.replace(/\s+/g, ' ').trim(), text: `${text}\n`, html };
}
