import type { Asset, SiteSpec } from '@bf/site-schema';

// Placeholder photos for fixture renders (BF-034): the fixtures' assets point at a test host, so the gallery and the
// visual/Lighthouse suites draw a calm, deterministic image per asset (gradients and soft shapes in the site's
// colours) instead of fetching anything. Never used on real sites.

const hash = (text: string) => {
  let h = 2166136261;
  for (const char of text) h = Math.imul(h ^ (char.codePointAt(0) ?? 0), 16777619);
  return h >>> 0;
};

function mix(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const value = (i: number) => Math.round(channel(a, i) * (1 - t) + channel(b, i) * t);
  return `#${[0, 1, 2].map((i) => value(i).toString(16).padStart(2, '0')).join('')}`;
}

/** An SVG standing in for a photo: a sky-to-ground gradient, a horizon and a few soft forms. */
export function placeholderSvg(asset: Asset, spec: SiteSpec): string {
  const { palette } = spec.theme;
  const seed = hash(asset.id);
  const colors = asset.dominantColors?.length
    ? asset.dominantColors
    : [palette.primary, palette.accent, palette.surface];
  const [c1 = palette.primary, c2 = palette.accent, c3 = palette.surface] = colors;
  const { width: w, height: h } = asset;
  if (asset.kind === 'logo') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><text x="50%" y="58%" text-anchor="middle" font-family="Georgia, serif" font-size="${Math.round(Math.min(h * 0.42, (w * 0.9) / (spec.brand.name.length * 0.55)))}" fill="${palette.text}" >${spec.brand.name.replace(/[<&>]/g, '')}</text></svg>`;
  }
  const horizon = 0.45 + (seed % 20) / 100;
  const sun = { x: 0.2 + ((seed >> 5) % 60) / 100, y: 0.18 + ((seed >> 9) % 20) / 100 };
  const forms = Array.from({ length: 3 }, (_, i) => {
    const x = (((seed >> (i * 4)) % 100) / 100) * w;
    const r = (0.18 + ((seed >> (i * 3 + 2)) % 20) / 100) * w;
    return `<ellipse cx="${x.toFixed(0)}" cy="${(h * (horizon + 0.12 + i * 0.08)).toFixed(0)}" rx="${r.toFixed(0)}" ry="${(r * 0.35).toFixed(0)}" fill="${mix(c1, '#000000', 0.15 + i * 0.1)}" opacity="0.55"/>`;
  }).join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice">`,
    '<defs>',
    `<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(c3, '#ffffff', 0.35)}"/><stop offset="${horizon}" stop-color="${mix(c2, c3, 0.4)}"/><stop offset="1" stop-color="${mix(c1, '#000000', 0.25)}"/></linearGradient>`,
    `<radialGradient id="g" cx="${sun.x}" cy="${sun.y}" r="0.5"><stop offset="0" stop-color="#ffffff" stop-opacity="0.75"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>`,
    '</defs>',
    `<rect width="${w}" height="${h}" fill="url(#s)"/>`,
    `<rect width="${w}" height="${h}" fill="url(#g)"/>`,
    `<rect y="${(h * horizon).toFixed(0)}" width="${w}" height="${(h * (1 - horizon)).toFixed(0)}" fill="${mix(c1, c2, 0.5)}" opacity="0.35"/>`,
    forms,
    '</svg>',
  ].join('');
}

/** Resolves fixture assets to their placeholder files (`/assets/<id>.svg`). */
export const placeholderResolver =
  (base = '/assets/') =>
  (asset: Asset) => ({ src: `${base}${asset.id}.svg` });
