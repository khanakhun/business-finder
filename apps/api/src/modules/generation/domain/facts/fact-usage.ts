import type { FactSource, FactUsage, RegistryFactKind, SourceProvider } from '@bf/contracts';

// Which facts a site may display (BF-040, ADR-0013): only those with at least one provenance licensed for display —
// the business's own website (its pages or JSON-LD), open data with a compatible licence (OSM, Overture, with
// attribution) or a workspace member. Facts known only from restricted providers stay internal (they may guide
// reasoning, e.g. the category, but never reach `facts.json`). Testimonials come only from the business's own site.

export const DISPLAY_SOURCES: ReadonlySet<FactSource> = new Set([
  'owner_site',
  'jsonld',
  'open_data',
  'user',
]);

/** The registry's source for a business-graph provider. */
export function sourceOfProvider(provider: SourceProvider): FactSource {
  switch (provider) {
    case 'website':
      return 'owner_site';
    case 'osm':
    case 'overture':
      return 'open_data';
    case 'manual':
    case 'import':
      return 'user';
    default:
      // google_places, gmaps_scraper, foursquare (Places API): their terms forbid display.
      return 'provider_restricted';
  }
}

export function usageFor(kind: RegistryFactKind, sources: readonly FactSource[]): FactUsage {
  // DECISION(BF-040): the business's name is the subject of the site, never licensed content: always displayable.
  if (kind === 'name') return 'display';
  if (kind === 'testimonial')
    return sources.some((source) => source === 'owner_site' || source === 'jsonld') ? 'display' : 'internal';
  return sources.some((source) => DISPLAY_SOURCES.has(source)) ? 'display' : 'internal';
}

/** The provenance that speaks for a fact first, when several state it. */
const SOURCE_RANK: Readonly<Record<FactSource, number>> = {
  user: 0,
  owner_site: 1,
  jsonld: 2,
  open_data: 3,
  golden_record: 4,
  provider_restricted: 5,
};

export const bestSource = (sources: readonly FactSource[]): FactSource =>
  [...sources].sort((a, b) => SOURCE_RANK[a] - SOURCE_RANK[b])[0] ?? 'provider_restricted';

/** Kinds a business has one of: a member's statement replaces the others (they stay internal, kept for audit). */
export const SINGLE_VALUED: ReadonlySet<RegistryFactKind> = new Set([
  'name',
  'tagline',
  'about_summary',
  'address',
  'geo',
  'hours',
  'website',
  'year_founded',
  'brand_color',
  'logo',
  'category',
]);
