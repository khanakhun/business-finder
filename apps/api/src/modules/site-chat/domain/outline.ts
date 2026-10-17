import type { SiteSpec } from '@bf/site-schema';

// The site as the edit agent first sees it (BF-047): pages, their blocks (id, type, variant, a short excerpt of their
// texts per locale), the theme and the locales. Compact on purpose: the agent reads a block in full when it needs to.

const EXCERPT = 80;

/** The first localized texts of a value, one short excerpt per locale. */
function excerpts(value: unknown, locales: readonly string[], out: Map<string, string>, depth = 0): void {
  if (depth > 4 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 3)) excerpts(item, locales, out, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length > 0 &&
    keys.every((key) => locales.includes(key)) &&
    keys.some((key) => typeof record[key] === 'string')
  ) {
    for (const locale of locales) {
      const text = record[locale];
      if (typeof text !== 'string' || out.has(locale)) continue;
      const plain = text
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (plain) out.set(locale, plain.length > EXCERPT ? `${plain.slice(0, EXCERPT - 1)}…` : plain);
    }
    return;
  }
  for (const key of keys) excerpts(record[key], locales, out, depth + 1);
}

export function siteOutline(spec: SiteSpec, maxChars = 12_000): string {
  const locales = spec.locales;
  const lines: string[] = [
    `Locales: ${locales.join(', ')} (default ${spec.defaultLocale})`,
    `Theme: ${JSON.stringify(spec.theme).slice(0, 400)}`,
  ];
  for (const page of spec.pages) {
    const title = page.title[spec.defaultLocale] ?? Object.values(page.title)[0] ?? page.id;
    lines.push(`Page ${page.id} "/${page.slug}" (${title}):`);
    for (const block of page.blocks) {
      const texts = new Map<string, string>();
      excerpts((block as { props?: unknown }).props, locales, texts);
      const sample = [...texts].map(([locale, text]) => `${locale}: ${text}`).join(' | ');
      lines.push(`  - ${block.id} ${block.type}/${block.variant}${sample ? ` — ${sample}` : ''}`);
    }
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars - 20)}\n… (outline cut)` : text;
}

/** Blocks on every page (the policy's denominator). */
export function blockCount(spec: SiteSpec): number {
  return spec.pages.reduce((sum, page) => sum + page.blocks.length, 0);
}
