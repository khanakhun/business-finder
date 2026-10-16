import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Asset, SiteSpec } from '@bf/site-schema';
import { FIXTURE_NAMES, readFixture } from './fixtures.ts';

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

/** An SVG standing in for a photo: sky, sun, horizon and a few hills in the site's colours. */
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
  // Flat colour bands and shapes (no gradients: screenshots of them compress well and render the same everywhere).
  const horizon = 0.45 + (seed % 20) / 100;
  const sun = { x: 0.2 + ((seed >> 5) % 60) / 100, y: 0.16 + ((seed >> 9) % 18) / 100 };
  const band = (from: number, to: number, color: string) =>
    `<rect y="${(h * from).toFixed(0)}" width="${w}" height="${(h * (to - from)).toFixed(0)}" fill="${color}"/>`;
  const hills = Array.from({ length: 3 }, (_, i) => {
    const x = (((seed >> (i * 4)) % 100) / 100) * w;
    const r = (0.2 + ((seed >> (i * 3 + 2)) % 20) / 100) * w;
    return `<ellipse cx="${x.toFixed(0)}" cy="${(h * (horizon + 0.14 + i * 0.09)).toFixed(0)}" rx="${r.toFixed(0)}" ry="${(r * 0.32).toFixed(0)}" fill="${mix(c1, '#000000', 0.12 + i * 0.12)}"/>`;
  }).join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice">`,
    band(0, 1, mix(c3, '#ffffff', 0.45)),
    band(horizon * 0.55, horizon, mix(c3, c2, 0.35)),
    `<circle cx="${(w * sun.x).toFixed(0)}" cy="${(h * sun.y).toFixed(0)}" r="${(Math.min(w, h) * 0.07).toFixed(0)}" fill="${mix(c3, '#ffffff', 0.8)}"/>`,
    band(horizon, 1, mix(c1, c2, 0.45)),
    hills,
    '</svg>',
  ].join('');
}

/** Resolves fixture assets to their placeholder files (`/assets/<id>.svg`). */
export const placeholderResolver =
  (base = '/assets/') =>
  (asset: Asset) => ({ src: `${base}${asset.id}.svg` });

/** Writes every fixture asset's placeholder to dist/assets/. */
export function writePlaceholders(): void {
  const dir = fileURLToPath(new URL('../../dist/assets/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  for (const name of FIXTURE_NAMES) {
    const spec = readFixture(name);
    for (const asset of spec.assets) writeFileSync(join(dir, `${asset.id}.svg`), placeholderSvg(asset, spec));
  }
}
