import {
  type OpenDataDataset,
  type OpenDataPlace,
  type OperatingStatus,
  type SourceRecordInput,
  SourceRecordSchema,
} from '@bf/contracts';

// Open-data place (from services/intel) → SourceRecord (BF-019). Openly licensed: storable, no expiry; the
// per-source licences travel in `attributes.sources` so attribution can be shown per record.

const STATUS: Record<NonNullable<OpenDataPlace['operatingStatus']>, OperatingStatus> = {
  open: 'operational',
  temporarily_closed: 'closed_temporarily',
  permanently_closed: 'closed_permanently',
};

const webUrl = (value: string) => (/^https?:\/\//i.test(value) ? value : undefined);
const clean = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  ) as Partial<T>;

export function openDataRecord(
  dataset: OpenDataDataset,
  release: string,
  place: OpenDataPlace,
  fetchedAt: Date,
): SourceRecordInput | null {
  const websites = place.websites.map(webUrl).filter((w): w is string => Boolean(w));
  // Nulls dropped: what remains are the address strings the contract accepts.
  const address = clean(place.address) as NonNullable<SourceRecordInput['address']>;
  const record: SourceRecordInput = {
    provider: dataset,
    providerRef: place.id,
    fetchedAt: fetchedAt.toISOString(),
    name: place.name,
    providerCategories: place.categories.map((c) => ({ key: c.key, ...(c.label ? { label: c.label } : {}) })),
    location: place.location,
    ...(Object.keys(address).length > 0 ? { address } : {}),
    phones: place.phones,
    ...(websites[0] ? { website: websites[0] } : {}),
    emails: place.emails,
    socials: place.socials.filter((s) => webUrl(s)),
    ...(place.operatingStatus ? { operatingStatus: STATUS[place.operatingStatus] } : {}),
    attributes: clean({
      release,
      confidence: place.confidence,
      brand: place.brand,
      otherWebsites: websites.length > 1 ? websites.slice(1) : null,
      // Upstream contributors and licences (Overture `sources`): attribution is per source.
      sources: place.sources.length > 0 ? place.sources : null,
    }),
    raw: place,
  };
  return SourceRecordSchema.safeParse(record).success ? record : null;
}
