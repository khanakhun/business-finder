import { type SourceRecordInput, SourceRecordSchema } from '@bf/contracts';

// gosom scraper CSV row → SourceRecord (BF-019). No licence: short retention, reviews never stored, raw kept to
// identifiers only. Values come from scraped pages: bounded and validated.

export const SCRAPER_RETENTION_DAYS = 30;

const parseJson = (value: string | undefined): unknown => {
  if (!value?.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const webUrl = (value: string | undefined) =>
  value && /^https?:\/\//i.test(value) ? value.slice(0, 2_000) : undefined;

export function scraperRecord(row: Record<string, string>, fetchedAt: Date): SourceRecordInput | null {
  const name = row.title?.trim();
  const ref = row.place_id?.trim() || row.cid?.trim() || row.data_id?.trim();
  const lat = Number(row.latitude);
  const lng = Number(row.longitude);
  if (!name || !ref || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const complete = parseJson(row.complete_address) as Record<string, string> | undefined;
  const address = Object.fromEntries(
    Object.entries({
      line1: complete?.street,
      city: complete?.city,
      postalCode: complete?.postal_code,
      region: complete?.state,
      countryCode: /^[A-Za-z]{2}$/.test(complete?.country ?? '')
        ? complete?.country?.toUpperCase()
        : undefined,
      formatted: row.address,
    })
      .filter(([, v]) => typeof v === 'string' && v.trim())
      .map(([k, v]) => [
        k,
        String(v)
          .trim()
          .slice(0, k === 'formatted' ? 400 : k === 'line1' ? 300 : 120),
      ]),
  );
  const emails = parseJson(row.emails);
  const rating = Number(row.review_rating);
  const reviews = Number(row.review_count);
  const status = row.status?.toLowerCase() ?? '';
  const record: SourceRecordInput = {
    provider: 'gmaps_scraper',
    providerRef: ref.slice(0, 300),
    fetchedAt: fetchedAt.toISOString(),
    expiresAt: new Date(fetchedAt.getTime() + SCRAPER_RETENTION_DAYS * 86_400_000).toISOString(),
    name: name.slice(0, 300),
    providerCategories: row.category?.trim() ? [{ key: row.category.trim().slice(0, 200) }] : [],
    location: { lat, lng },
    ...(Object.keys(address).length > 0 ? { address } : {}),
    phones: row.phone?.trim() ? [row.phone.trim().slice(0, 40)] : [],
    ...(webUrl(row.website) ? { website: webUrl(row.website) } : {}),
    emails: Array.isArray(emails)
      ? emails
          .filter((e): e is string => typeof e === 'string')
          .map((e) => e.slice(0, 254))
          .slice(0, 20)
      : [],
    ...(rating >= 0 && rating <= 5 && row.review_rating ? { rating } : {}),
    ...(Number.isInteger(reviews) && reviews >= 0 && row.review_count ? { reviewCount: reviews } : {}),
    operatingStatus: status.includes('permanently')
      ? 'closed_permanently'
      : status.includes('temporarily')
        ? 'closed_temporarily'
        : 'unknown',
    attributes: { link: webUrl(row.link) },
    // Identifiers only: no reviews, photos or page content are kept.
    raw: { place_id: row.place_id || null, cid: row.cid || null },
  };
  return SourceRecordSchema.safeParse(record).success ? record : null;
}
