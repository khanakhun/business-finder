// Pattern stage of location resolution (BF-017): inputs with a fixed shape are recognised before any lookup.

export type LocationPattern =
  | { readonly kind: 'nl_postcode'; readonly pc4: string; readonly full: string | null }
  | { readonly kind: 'us_zip'; readonly zip: string }
  | { readonly kind: 'radius'; readonly radiusM: number; readonly place: string }
  | { readonly kind: 'latlng'; readonly lat: number; readonly lng: number; readonly radiusM: number | null };

const KM = 1000;
const MILE = 1609.344;
/** "near X" / "autour de X" without a distance. */
export const DEFAULT_NEAR_RADIUS_M = 2000;
const MAX_RADIUS_M = 200_000;

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
const UNIT = String.raw`(km|kms|kilom[eè]tres?|kilometers?|m|m[eè]tres?|meters?|mi|miles?)`;

const RADIUS_PATTERNS: RegExp[] = [
  // within 5 km of Lorient / within 3 miles from X
  new RegExp(String.raw`^within\s+${NUMBER}\s*${UNIT}\s+(?:of|from|around)\s+(.+)$`, 'i'),
  // 5 km around X / 5km of X
  new RegExp(String.raw`^${NUMBER}\s*${UNIT}\s+(?:around|of|from)\s+(.+)$`, 'i'),
  // dans un rayon de 2 km autour de Gustavia / dans un rayon de 2 km de Gustavia
  new RegExp(
    String.raw`^dans\s+un\s+rayon\s+de\s+${NUMBER}\s*${UNIT}\s+(?:autour\s+de|de|d['’])\s*(.+)$`,
    'i',
  ),
  // à 3 km de Gustavia / a moins de 3 km de X
  new RegExp(
    String.raw`^(?:[àa]\s+(?:moins\s+de\s+)?)${NUMBER}\s*${UNIT}\s+(?:de|d['’]|autour\s+de)\s*(.+)$`,
    'i',
  ),
];
const NEAR_PATTERNS: RegExp[] = [
  /^(?:near|around|close to)\s+(.+)$/i,
  /^(?:pr[eè]s\s+de|autour\s+de|aux\s+alentours\s+de)\s+(.+)$/i,
];

function toMeters(value: string, unit: string): number {
  const n = Number(value.replace(',', '.'));
  const u = unit.toLowerCase();
  if (u === 'mi' || u.startsWith('mile')) return n * MILE;
  if (u === 'm' || /^m[eè]tre|^meter/.test(u)) return n;
  return n * KM;
}

const LATLNG = /^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/;

const inRange = (lat: number, lng: number) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/**
 * Recognises fixed-shape inputs. Bare digits are ambiguous ("97133" is Saint-Barthélemy's postcode, "75001" a
 * Paris one, "2024" a year), so they read as an NL PC4 or a US ZIP only when the country hint is that country or
 * absent; otherwise they fall through to name lookup. "1012 AB" (digits + letters) is always Dutch.
 */
export function parseLocationPattern(raw: string, countryHint: string | null = null): LocationPattern | null {
  const text = raw.trim().replace(/\s+/g, ' ');
  const nl = /^(\d{4})\s?([A-Za-z]{2})?$/.exec(text);
  if (nl && !/^0/.test(nl[1] as string) && (nl[2] || !countryHint || countryHint === 'NL')) {
    return {
      kind: 'nl_postcode',
      pc4: nl[1] as string,
      full: nl[2] ? `${nl[1]} ${(nl[2] as string).toUpperCase()}` : null,
    };
  }
  const zip = /^(\d{5})(-\d{4})?$/.exec(text);
  if (zip && (zip[2] || !countryHint || countryHint === 'US'))
    return { kind: 'us_zip', zip: zip[1] as string };
  const point = LATLNG.exec(text);
  if (point) {
    const lat = Number(point[1]);
    const lng = Number(point[2]);
    if (inRange(lat, lng)) return { kind: 'latlng', lat, lng, radiusM: null };
  }
  for (const pattern of RADIUS_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const radiusM = Math.min(MAX_RADIUS_M, Math.round(toMeters(m[1] as string, m[2] as string)));
    const place = (m[3] as string).trim();
    if (radiusM <= 0 || !place) return null;
    const inner = LATLNG.exec(place);
    if (inner) {
      const lat = Number(inner[1]);
      const lng = Number(inner[2]);
      return inRange(lat, lng) ? { kind: 'latlng', lat, lng, radiusM } : null;
    }
    return { kind: 'radius', radiusM, place };
  }
  for (const pattern of NEAR_PATTERNS) {
    const m = pattern.exec(text);
    if (m) return { kind: 'radius', radiusM: DEFAULT_NEAR_RADIUS_M, place: (m[1] as string).trim() };
  }
  return null;
}
