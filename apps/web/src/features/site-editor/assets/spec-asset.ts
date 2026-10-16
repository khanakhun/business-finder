import type { SiteAsset } from '@bf/contracts';
import { type Asset, AssetSchema, type LocalizedText, type SiteLocale, type SiteSpec } from '@bf/site-schema';

// The image library's assets (BF-035 `SiteAsset`, stored per site) as the spec's images (BF-033 `Asset`): a site
// names an image by its own element id; its URL is the library's public variant. Pure, for the AssetPicker.

/**
 * Providers whose images may not be republished (maps, review and booking sites): shown in the library, never
 * selectable. Matched against `licenseDetails.provider`, case-insensitively.
 */
const RESTRICTED_PROVIDERS = [
  'google',
  'google_places',
  'google maps',
  'tripadvisor',
  'yelp',
  'facebook',
  'instagram',
  'booking.com',
  'airbnb',
] as const;

export function isRestricted(asset: SiteAsset): boolean {
  const provider = asset.licenseDetails?.provider?.trim().toLowerCase();
  return provider !== undefined && (RESTRICTED_PROVIDERS as readonly string[]).includes(provider);
}

/** An image the site can use: processed, with its public URL and size. */
export function isUsable(
  asset: SiteAsset,
): asset is SiteAsset & { publicUrl: string; width: number; height: number } {
  return (
    asset.status === 'ready' &&
    asset.publicUrl !== null &&
    asset.width !== null &&
    asset.height !== null &&
    !isRestricted(asset)
  );
}

export type Orientation = 'landscape' | 'portrait' | 'square';

export function orientationOf(width: number, height: number): Orientation {
  const ratio = width / height;
  if (ratio > 1.1) return 'landscape';
  if (ratio < 0.9) return 'portrait';
  return 'square';
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A new element id for an image (`img_` and 10 random characters: 14, within the spec's 6–32), unused in `taken`. */
export function mintAssetId(
  taken: ReadonlySet<string>,
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (bytes) =>
    crypto.getRandomValues(bytes),
): string {
  for (;;) {
    const bytes = random(new Uint8Array(10));
    const id = `img_${Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('')}`;
    if (!taken.has(id)) return id;
  }
}

/** The site's image already pointing at this library asset's URL, if any (picking it again reuses it). */
export function specAssetFor(spec: SiteSpec, asset: SiteAsset): Asset | undefined {
  return asset.publicUrl ? spec.assets.find((candidate) => candidate.url === asset.publicUrl) : undefined;
}

/** Its alt texts in the site's languages (the library may hold others). */
export function altFor(asset: SiteAsset, locales: readonly SiteLocale[]): LocalizedText {
  const alt: Partial<Record<SiteLocale, string>> = {};
  for (const locale of locales) {
    const text = asset.alt?.[locale]?.trim();
    if (text) alt[locale] = text;
  }
  return alt;
}

/**
 * The library asset as a new image of the site, with a fresh id; `alt` and `focalPoint` override the library's.
 * Undefined when it cannot be one (not processed, restricted, or no alt text in any of the site's languages).
 */
export function toSpecAsset(
  asset: SiteAsset,
  spec: SiteSpec,
  options: { readonly alt?: LocalizedText; readonly focalPoint?: { x: number; y: number } } = {},
): Asset | undefined {
  if (!isUsable(asset)) return undefined;
  const attribution = asset.licenseDetails?.attributionText ?? asset.licenseDetails?.author;
  const candidate = {
    id: mintAssetId(new Set(spec.assets.map((existing) => existing.id))),
    kind: asset.kind === 'logo' ? ('logo' as const) : ('image' as const),
    url: asset.publicUrl,
    width: asset.width,
    height: asset.height,
    alt: options.alt ?? altFor(asset, spec.locales),
    license: asset.license,
    ...(attribution ? { attribution: attribution.slice(0, 200) } : {}),
    // A stock credit links to the photographer's page (the validator allows the stock sites only).
    ...(asset.license === 'stock' && asset.licenseDetails?.authorUrl
      ? { attributionUrl: asset.licenseDetails.authorUrl }
      : {}),
    ...(asset.hosting === 'hotlink' ? { hosting: 'hotlink' as const } : {}),
    // An owner-site image whose ownership is not confirmed stays preview-only in the spec (refused on a live site).
    ...(asset.restrictions.length > 0 ? { restrictions: [...asset.restrictions] } : {}),
    ...(options.focalPoint
      ? { focalPoint: options.focalPoint }
      : asset.focalPoint
        ? { focalPoint: asset.focalPoint }
        : {}),
    ...(asset.dominantColors?.length ? { dominantColors: asset.dominantColors.slice(0, 5) } : {}),
  };
  const parsed = AssetSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
