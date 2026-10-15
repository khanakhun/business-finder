import { type OperatingStatus, type SourceRecordInput, SourceRecordSchema } from '@bf/contracts';
import { z } from 'zod';
import { GOOGLE_RETENTION_DAYS } from './licensing.ts';

// Places API (New) `Place` → SourceRecord (BF-018). Every field is optional in responses: parse defensively and
// drop what does not validate. Content is untrusted (ingestion normalizes it).

/** http(s) URLs only (a `javascript:` link rendered later would be stored XSS), bounded. */
const webUrl = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => /^https?:\/\//i.test(value))
    .optional()
    .catch(undefined);
/** Free text cut to the contract's limit instead of failing the whole record. */
const bounded = (max: number) => z.string().transform((value) => value.slice(0, max));

const LocalizedText = z.object({ text: z.string(), languageCode: z.string().optional() });
const TimePoint = z.object({
  day: z.number().int().min(0).max(6),
  hour: z.number().int(),
  minute: z.number().int(),
});

export const GooglePlaceSchema = z.object({
  id: z.string().min(1).max(300),
  displayName: LocalizedText.optional(),
  formattedAddress: z.string().optional(),
  addressComponents: z
    .array(
      z.object({
        longText: z.string().optional(),
        shortText: z.string().optional(),
        types: z.array(z.string()),
      }),
    )
    .optional(),
  location: z
    .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
    .optional(),
  types: z.array(z.string()).optional(),
  primaryType: z.string().optional(),
  primaryTypeDisplayName: LocalizedText.optional(),
  businessStatus: z.string().optional(),
  googleMapsUri: webUrl(500),
  utcOffsetMinutes: z.number().optional(),
  websiteUri: webUrl(2_000),
  nationalPhoneNumber: z.string().optional(),
  internationalPhoneNumber: z.string().optional(),
  rating: z.number().min(0).max(5).optional(),
  userRatingCount: z.number().int().min(0).optional(),
  regularOpeningHours: z
    .object({ periods: z.array(z.object({ open: TimePoint, close: TimePoint.optional() })).optional() })
    .optional(),
  priceLevel: z.string().optional(),
  attributions: z
    .array(z.object({ provider: bounded(200).optional(), providerUri: webUrl(500) }))
    .max(10)
    .catch([])
    .optional(),
});
export type GooglePlace = z.infer<typeof GooglePlaceSchema>;

/** Generic Google types that say nothing about the business. */
const GENERIC_TYPES = new Set(['point_of_interest', 'establishment']);

const STATUS: Record<string, OperatingStatus> = {
  OPERATIONAL: 'operational',
  CLOSED_TEMPORARILY: 'closed_temporarily',
  CLOSED_PERMANENTLY: 'closed_permanently',
};

const PRICE: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

const hhmm = (p: { hour: number; minute: number }) =>
  `${String(Math.min(23, p.hour)).padStart(2, '0')}:${String(Math.min(59, p.minute)).padStart(2, '0')}`;
/** Google counts days from Sunday (0); we count from Monday (0). */
const weekday = (googleDay: number) => (googleDay + 6) % 7;

function hoursOf(place: GooglePlace): SourceRecordInput['hours'] {
  const periods = place.regularOpeningHours?.periods;
  if (!periods?.length) return undefined;
  // A single period opening Sunday 00:00 with no close means "open 24 hours, every day".
  if (
    periods.length === 1 &&
    !periods[0]?.close &&
    periods[0]?.open.hour === 0 &&
    periods[0].open.minute === 0
  ) {
    return Array.from({ length: 7 }, (_, day) => ({ weekday: day, opensAt: '00:00', closesAt: '23:59' }));
  }
  return periods
    .filter((p) => p.close)
    .map((p) => ({ weekday: weekday(p.open.day), opensAt: hhmm(p.open), closesAt: hhmm(p.close ?? p.open) }));
}

function addressOf(place: GooglePlace): SourceRecordInput['address'] {
  const components = place.addressComponents ?? [];
  const part = (type: string, short = false) => {
    const c = components.find((x) => x.types.includes(type));
    return ((short ? c?.shortText : c?.longText) ?? c?.longText ?? c?.shortText)?.slice(0, 120);
  };
  const line1 = [part('street_number'), part('route')].filter(Boolean).join(' ') || undefined;
  const address = {
    line1,
    line2: part('subpremise'),
    city: part('locality') ?? part('postal_town') ?? part('administrative_area_level_2'),
    postalCode: part('postal_code'),
    region: part('administrative_area_level_1'),
    countryCode: part('country', true)?.toUpperCase(),
    formatted: place.formattedAddress?.slice(0, 400),
  };
  const defined = Object.fromEntries(
    Object.entries(address).filter(([, v]) => v),
  ) as SourceRecordInput['address'];
  return defined && Object.keys(defined).length > 0 ? defined : undefined;
}

/** A Place as a source record, or null when it lacks what ingestion needs (an id and a name). */
export function toSourceRecord(raw: unknown, fetchedAt: Date): SourceRecordInput | null {
  const record = mapPlace(raw, fetchedAt);
  // The contract is the gate: a record ingestion would reject is dropped here, not half-stored.
  return record && SourceRecordSchema.safeParse(record).success ? record : null;
}

function mapPlace(raw: unknown, fetchedAt: Date): SourceRecordInput | null {
  const parsed = GooglePlaceSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.displayName?.text.trim()) return null;
  const place = parsed.data;
  const types = [place.primaryType, ...(place.types ?? [])].filter(
    (t, i, all): t is string => Boolean(t) && !GENERIC_TYPES.has(t as string) && all.indexOf(t) === i,
  );
  const phone = (place.internationalPhoneNumber ?? place.nationalPhoneNumber)?.slice(0, 40);
  const priceLevel = place.priceLevel ? PRICE[place.priceLevel] : undefined;
  const expiresAt = new Date(fetchedAt.getTime() + GOOGLE_RETENTION_DAYS * 86_400_000);
  return {
    provider: 'google_places',
    providerRef: place.id,
    fetchedAt: fetchedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    name: (place.displayName?.text ?? '').trim().slice(0, 300),
    providerCategories: types.slice(0, 30).map((key) => ({
      key,
      ...(key === place.primaryType && place.primaryTypeDisplayName
        ? { label: place.primaryTypeDisplayName.text.slice(0, 200) }
        : {}),
    })),
    ...(place.location ? { location: { lat: place.location.latitude, lng: place.location.longitude } } : {}),
    ...(addressOf(place) ? { address: addressOf(place) } : {}),
    phones: phone ? [phone] : [],
    ...(place.websiteUri ? { website: place.websiteUri } : {}),
    ...(hoursOf(place) ? { hours: hoursOf(place) } : {}),
    ...(place.rating !== undefined ? { rating: place.rating } : {}),
    ...(place.userRatingCount !== undefined ? { reviewCount: place.userRatingCount } : {}),
    ...(priceLevel !== undefined ? { priceLevel } : {}),
    operatingStatus: (place.businessStatus && STATUS[place.businessStatus]) || 'unknown',
    attributes: Object.fromEntries(
      Object.entries({
        googleMapsUri: place.googleMapsUri,
        primaryType: place.primaryType,
        utcOffsetMinutes: place.utcOffsetMinutes,
        // Third-party data providers Google names must be attributed next to "Google Maps".
        attributions: place.attributions,
      }).filter(([, value]) => value !== undefined),
    ),
    // Only the place id may be kept indefinitely: no copy of the payload is stored.
    raw: { id: place.id },
  };
}
