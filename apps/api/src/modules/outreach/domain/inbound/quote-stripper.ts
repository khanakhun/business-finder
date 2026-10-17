// The new part of a reply (BF-054): quoted history removed before triage (the full sanitized text stays for display).
// Cuts at the first reply separator — "On … wrote:", « Le … a écrit : », Outlook's original-message headers (EN/FR),
// a forwarded-message banner, a signature delimiter — and drops `>` quoted lines.

const SEPARATORS = [
  /^\s*On .{0,200}wrote:\s*$/im,
  /^\s*Le .{0,200}a écrit\s*:\s*$/im,
  /^\s*-{2,}\s*(Original Message|Message d['’]origine|Forwarded message|Message transféré)\s*-{2,}/im,
  /^\s*_{10,}\s*$/m,
  /^\s*(From|De)\s*:.+\r?\n\s*(Sent|Envoyé|Date)\s*:/im,
  /^\s*Envoyé de mon (iPhone|iPad|mobile)/im,
  /^\s*Sent from my (iPhone|iPad|mobile|Android)/im,
  /^-- $/m,
];

export function stripQuotes(text: string): string {
  let cut = text.replace(/\r\n/g, '\n');
  for (const separator of SEPARATORS) {
    const match = separator.exec(cut);
    if (match && match.index > 0) cut = cut.slice(0, match.index);
    else if (match && match.index === 0) cut = '';
  }
  return cut
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
