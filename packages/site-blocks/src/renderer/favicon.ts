import { onColor, type SiteSpec } from '@bf/site-schema';

/**
 * The site's icon: its initial on its primary colour, as an SVG data URI (no request, no 404 in the console). Only a
 * Latin letter or digit is drawn, and the colours are re-checked hex: nothing from the spec reaches the URI otherwise.
 */
export function faviconHref(spec: SiteSpec): string {
  const hex = (value: string, fallback: string) => (/^#[0-9a-f]{6}$/i.test(value) ? value : fallback);
  const background = hex(spec.theme.palette.primary, '#1f2937');
  const initial = spec.brand.name
    .normalize('NFD')
    .replace(/[^A-Za-z0-9]/g, '')
    .charAt(0)
    .toUpperCase();
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='${background}'/>` +
    (initial
      ? `<text x='32' y='44' font-size='34' font-family='system-ui,sans-serif' font-weight='700' text-anchor='middle' fill='${onColor(background)}'>${initial}</text>`
      : '') +
    '</svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
