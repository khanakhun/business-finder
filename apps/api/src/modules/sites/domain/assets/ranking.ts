// Explainable ranking of a business's images per role (BF-038): every point added or taken has a reason a person
// can read. Owner-site photos are preferred for the "about" and gallery roles when they are good; a weak owner
// photo gives way to stock or AI for the hero. Pure: it reads what processing and analysis measured.

export type AssetRole = 'hero' | 'gallery' | 'about' | 'og' | 'logo' | 'favicon';

export interface RankableAsset {
  readonly id: string;
  readonly kind: 'photo' | 'logo';
  readonly source: 'upload' | 'owner_site' | 'stock' | 'ai' | 'wordmark';
  readonly width: number;
  readonly height: number;
  readonly analysis: {
    readonly quality: number;
    readonly heroSuitability: number;
    readonly containsText: boolean;
    readonly containsPeople: boolean;
    readonly identifiablePeople: boolean;
  } | null;
  readonly dominantColors: readonly string[] | null;
}

export interface Ranked<T extends RankableAsset> {
  readonly asset: T;
  /** 0–100. */
  readonly score: number;
  readonly reasons: readonly string[];
}

const PHOTO_ROLES: ReadonlySet<AssetRole> = new Set(['hero', 'gallery', 'about', 'og']);

/** Ranks the assets that suit `role` (logos for logo/favicon, photos otherwise), best first; ties keep input order. */
export function rankCandidates<T extends RankableAsset>(
  assets: readonly T[],
  options: { readonly role: AssetRole; readonly palette?: readonly string[] },
): Ranked<T>[] {
  const wanted = PHOTO_ROLES.has(options.role) ? 'photo' : 'logo';
  return assets
    .filter((asset) => asset.kind === wanted)
    .map((asset, index) => ({ index, ranked: score(asset, options.role, options.palette ?? []) }))
    .filter(({ ranked }) => ranked !== null)
    .sort((a, b) => (b.ranked?.score ?? 0) - (a.ranked?.score ?? 0) || a.index - b.index)
    .map(({ ranked }) => ranked as Ranked<T>);
}

function score<T extends RankableAsset>(
  asset: T,
  role: AssetRole,
  palette: readonly string[],
): Ranked<T> | null {
  const reasons: string[] = [];
  let points = 0;
  const add = (value: number, reason: string) => {
    points += value;
    reasons.push(`${value >= 0 ? '+' : ''}${value} ${reason}`);
  };

  if (asset.kind === 'logo') {
    if (asset.source === 'wordmark') add(40, 'generated wordmark (no logo found)');
    else add(70, "the business's own logo");
    const ratio = asset.width / asset.height;
    if (role === 'favicon') {
      if (Math.abs(ratio - 1) < 0.2) add(20, 'square, fits a favicon');
      else add(-15, 'not square for a favicon');
    } else if (ratio >= 1.5) add(10, 'wide, fits a header');
    return { asset, score: clamp(points), reasons };
  }

  // Photos: AI images never show people (policy); one that does is not offered.
  if (asset.source === 'ai' && asset.analysis?.containsPeople) return null;
  const analysis = asset.analysis;
  if (analysis) add((analysis.quality - 1) * 10, `quality ${analysis.quality}/5`);
  else add(20, 'not analysed yet (neutral quality)');

  const long = Math.max(asset.width, asset.height);
  const landscape = asset.width / asset.height >= 1.2;
  if (role === 'hero' || role === 'og') {
    if (analysis) add((analysis.heroSuitability - 3) * 6, `hero suitability ${analysis.heroSuitability}/5`);
    if (landscape) add(10, 'landscape');
    else add(-10, 'not landscape');
    if (asset.width >= 1600) add(10, 'wide enough for a full-width hero');
    else if (asset.width < 1200) add(-10, 'narrow for a hero');
  } else if (long >= 1200) add(5, 'large enough');

  const ownGood = asset.source === 'owner_site' && (analysis?.quality ?? 3) >= 3;
  if ((role === 'about' || role === 'gallery') && ownGood) add(15, "the business's own photo");
  if (role === 'hero' && asset.source === 'owner_site' && analysis && analysis.quality < 3)
    add(-10, 'weak own photo: stock or AI preferred for the hero');
  if (role === 'hero' && (asset.source === 'stock' || asset.source === 'ai')) add(5, 'curated for heroes');
  if (analysis?.containsText) add(-10, 'contains text');
  if (role !== 'about' && analysis?.identifiablePeople) add(-5, 'identifiable people');

  const fit = paletteFit(asset.dominantColors ?? [], palette);
  if (fit !== null) add(Math.round(fit * 10), 'colours close to the palette');
  return { asset, score: clamp(points), reasons };
}

const clamp = (value: number) => Math.max(0, Math.min(100, value));

/** 0–1: how close the image's main colours come to the palette (CIE76 ΔE, 0 at ΔE ≥ 50); null without colours. */
export function paletteFit(colors: readonly string[], palette: readonly string[]): number | null {
  const a = colors.flatMap((hex) => toLab(hex) ?? []);
  const b = palette.flatMap((hex) => toLab(hex) ?? []);
  if (a.length === 0 || b.length === 0) return null;
  let best = Number.POSITIVE_INFINITY;
  for (const x of a) for (const y of b) best = Math.min(best, deltaE(x, y));
  return Math.max(0, 1 - best / 50);
}

type Lab = readonly [number, number, number];

function toLab(hex: string): Lab[] | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1], 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, bl] = [channel(16), channel(8), channel(0)];
  // sRGB → XYZ (D65) → Lab.
  const x = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + bl * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [[116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]];
}

const deltaE = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
