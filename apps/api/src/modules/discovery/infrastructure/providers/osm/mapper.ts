import { type SourceRecordInput, SourceRecordSchema } from '@bf/contracts';
import { parseOpeningHours } from './opening-hours.ts';
import { CATEGORY_KEYS } from './overpass.ts';

// Overpass element → SourceRecord (BF-019). OSM data is ODbL: storable, attribution required; tags are kept as
// the raw payload. Values are free text from contributors: bounded and validated against the contract.

export interface OverpassElement {
  readonly type: 'node' | 'way' | 'relation';
  readonly id: number;
  readonly lat?: number | undefined;
  readonly lon?: number | undefined;
  readonly center?: { readonly lat: number; readonly lon: number } | undefined;
  readonly tags?: Readonly<Record<string, string>> | undefined;
}

const split = (value: string | undefined) =>
  (value ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

const firstOf = (tags: Readonly<Record<string, string>>, ...keys: string[]) =>
  keys.map((k) => tags[k]?.trim()).find((v) => v);

const webUrl = (value: string | undefined) =>
  value && /^https?:\/\//i.test(value)
    ? value.slice(0, 2_000)
    : value && /^www\./i.test(value)
      ? `https://${value}`
      : undefined;

const SOCIAL_KEYS = [
  'contact:facebook',
  'contact:instagram',
  'contact:twitter',
  'contact:linkedin',
  'contact:tiktok',
];

export function osmRecord(element: OverpassElement, fetchedAt: Date): SourceRecordInput | null {
  const tags = element.tags ?? {};
  const name = tags.name?.trim();
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  if (!name || lat === undefined || lng === undefined) return null;
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const address = Object.fromEntries(
    Object.entries({
      line1: street || undefined,
      city: firstOf(tags, 'addr:city', 'addr:place'),
      postalCode: tags['addr:postcode'],
      region: tags['addr:state'],
      countryCode: /^[A-Za-z]{2}$/.test(tags['addr:country'] ?? '')
        ? tags['addr:country']?.toUpperCase()
        : undefined,
    })
      .filter(([, v]) => v)
      .map(([k, v]) => [k, String(v).slice(0, k === 'line1' ? 300 : 120)]),
  );
  const hours = parseOpeningHours(tags.opening_hours);
  const record: SourceRecordInput = {
    provider: 'osm',
    providerRef: `${element.type}/${element.id}`,
    fetchedAt: fetchedAt.toISOString(),
    name: name.slice(0, 300),
    providerCategories: CATEGORY_KEYS.filter((k) => tags[k]).map((k) => ({
      key: `${k}=${tags[k]}`.slice(0, 200),
    })),
    location: { lat, lng },
    ...(Object.keys(address).length > 0 ? { address } : {}),
    phones: [
      ...new Set([...split(tags.phone), ...split(tags['contact:phone']), ...split(tags['contact:mobile'])]),
    ]
      .map((p) => p.slice(0, 40))
      .slice(0, 10),
    ...(webUrl(firstOf(tags, 'website', 'contact:website', 'url'))
      ? { website: webUrl(firstOf(tags, 'website', 'contact:website', 'url')) }
      : {}),
    emails: [...new Set([...split(tags.email), ...split(tags['contact:email'])])]
      .map((e) => e.slice(0, 254))
      .slice(0, 20),
    socials: SOCIAL_KEYS.map((k) => webUrl(tags[k])).filter((s): s is string => Boolean(s)),
    ...(hours ? { hours } : {}),
    operatingStatus: tags['disused:shop'] || tags['disused:amenity'] ? 'closed_permanently' : 'unknown',
    attributes: {
      osmType: element.type,
      ...(tags.opening_hours ? { openingHours: tags.opening_hours.slice(0, 500) } : {}),
    },
    raw: { type: element.type, id: element.id, tags },
  };
  return SourceRecordSchema.safeParse(record).success ? record : null;
}
