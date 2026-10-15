import {
  type AreaCandidate,
  DomainError,
  type GeoAreaKind,
  type Locale,
  type LocationNotice,
  type LocationResolution,
  type MultiPolygon,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { LOGGER } from '../../platform/logging/logger.ts';
import { normalizeAreaName } from '../domain/area-names.ts';
import { bboxOf, centroidOf } from '../domain/geometry.ts';
import { type LocationPattern, parseLocationPattern } from '../domain/location-patterns.ts';
import {
  type AreaMatch,
  GEO_AREA_REPOSITORY,
  GEOCODE_CACHE,
  GEOCODE_QUOTA,
  GEOCODER,
  type GeoAreaRecord,
  type GeoAreaRepository,
  type GeocodeCache,
  type GeocodeCacheKey,
  type GeocodeQuery,
  type GeocodeQuota,
  type GeocodeResult,
  type Geocoder,
} from './ports.ts';

export interface ResolveOptions {
  readonly locale: Locale;
  /** Country to prefer for ambiguous names (workspace default, e.g. BL). */
  readonly countryHint: string | null;
  /** The caller named the country explicitly: external answers are restricted to it, not just biased. */
  readonly strictCountry?: boolean;
  readonly organizationId: string | null;
}

const KIND_BONUS: Partial<Record<GeoAreaKind, number>> = {
  locality: 0.04,
  island: 0.03,
  district: 0.02,
  custom: 0.02,
};
/** Empty answers are retried sooner: the place may be added upstream, or the miss may be transient. */
const NEGATIVE_TTL_SECONDS = 6 * 3600;
/** Below this, local matches are not trusted alone and the external geocoder is asked too. */
const LOCAL_TRUST = 0.7;
/** A fuzzy (non-exact) name match never reaches the auto-pick threshold (0.8) on its own. */
const FUZZY_CAP = 0.75;
/** Sources whose stored areas came from the geocoder: they never short-circuit it (other places share names). */
const GEOCODER_SOURCES = new Set<string>(['nominatim', 'google']);

const clamp = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;

type Candidates = { readonly candidates: AreaCandidate[]; readonly notice: LocationNotice | null };

/**
 * Turns free text into candidate areas (BF-017), Chain of Responsibility: fixed patterns (postcodes, ZIPs, radius
 * phrases, coordinates) → local `geo_areas` (names and aliases, accent-insensitive, country-biased) → external
 * geocoder (cached; administrative polygons stored as areas). Ambiguous names return several candidates. The
 * geocoder is best effort: when it fails or the workspace's quota is spent, local results come back with a notice.
 */
@Injectable()
export class LocationResolver {
  /** Identical lookups in flight share one provider call (the provider allows one request per second). */
  private readonly inFlight = new Map<string, Promise<GeocodeResult[]>>();

  constructor(
    @Inject(GEO_AREA_REPOSITORY) private readonly areas: GeoAreaRepository,
    @Inject(GEOCODE_CACHE) private readonly cache: GeocodeCache,
    @Inject(GEOCODE_QUOTA) private readonly quota: GeocodeQuota,
    @Inject(LOGGER) private readonly logger: Logger,
    @Optional() @Inject(GEOCODER) private readonly geocoder: Geocoder | null = null,
  ) {}

  async resolve(text: string, options: ResolveOptions): Promise<LocationResolution> {
    const query = text.trim();
    const pattern = parseLocationPattern(query, options.countryHint);
    const { candidates, notice } = pattern
      ? await this.fromPattern(pattern, options)
      : await this.byName(query, options);
    const sorted = byConfidence(candidates).slice(0, 5);
    const [top, second] = sorted;
    const chosen =
      top && top.confidence >= 0.8 && (!second || second.confidence <= top.confidence - 0.1) ? 0 : null;
    return { query, candidates: sorted, chosen, notice };
  }

  private async fromPattern(pattern: LocationPattern, options: ResolveOptions): Promise<Candidates> {
    switch (pattern.kind) {
      case 'nl_postcode':
        return this.postal('NL', pattern.pc4, pattern.full ?? pattern.pc4, options);
      case 'us_zip':
        return this.postal('US', pattern.zip, pattern.zip, options);
      case 'latlng': {
        const radiusM = pattern.radiusM ?? 1000;
        const geometry = { type: 'Circle' as const, center: { lat: pattern.lat, lng: pattern.lng }, radiusM };
        return {
          notice: null,
          candidates: [
            {
              areaId: null,
              kind: 'custom',
              label: `${(radiusM / 1000).toLocaleString(options.locale)} km · ${pattern.lat}, ${pattern.lng}`,
              geometry,
              bbox: bboxOf(geometry),
              confidence: 1,
              source: 'pattern',
            },
          ],
        };
      }
      case 'radius': {
        const places = await this.byName(pattern.place, options);
        return {
          notice: places.notice,
          candidates: byConfidence(places.candidates)
            .slice(0, 3)
            .map((place) => {
              const geometry = { type: 'Circle' as const, center: centerOf(place), radiusM: pattern.radiusM };
              const km = (pattern.radiusM / 1000).toLocaleString(options.locale);
              return {
                areaId: null,
                kind: 'custom' as const,
                label:
                  options.locale === 'fr'
                    ? `${km} km autour de ${place.label}`
                    : `${km} km around ${place.label}`,
                geometry,
                bbox: bboxOf(geometry),
                confidence: clamp(place.confidence * 0.98),
                source: 'pattern' as const,
              };
            }),
        };
      }
    }
  }

  private async postal(
    country: string,
    code: string,
    label: string,
    options: ResolveOptions,
  ): Promise<Candidates> {
    const area = await this.areas.findByCode('postal_code', code, country);
    if (area)
      return { candidates: await this.toCandidates([{ area, confidence: 0.95 }], options), notice: null };
    // Pack not imported: ask the geocoder, restricted to the country.
    return this.geocode(`${label}, ${country === 'NL' ? 'Netherlands' : 'United States'}`, {
      ...options,
      countryHint: country,
      strictCountry: true,
    });
  }

  private async byName(text: string, options: ResolveOptions): Promise<Candidates> {
    const matches = await this.areas.match(text, { organizationId: options.organizationId, limit: 8 });
    const local = await this.toCandidates(
      matches.map((m) => ({ area: m.area, confidence: this.localConfidence(m, options) })),
      options,
    );
    const trusted = matches.some(
      (m, i) => (local[i]?.confidence ?? 0) >= LOCAL_TRUST && !GEOCODER_SOURCES.has(m.area.source),
    );
    if (trusted) return { candidates: local, notice: null };
    const external = await this.geocode(text, options);
    // An external answer already stored as an area appears once (the local one).
    const known = new Set(local.map((c) => c.areaId).filter(Boolean));
    return {
      candidates: [...local, ...external.candidates.filter((c) => !c.areaId || !known.has(c.areaId))],
      notice: external.notice,
    };
  }

  private localConfidence(match: AreaMatch, options: ResolveOptions): number {
    let confidence = match.exact ? 0.9 : match.score * 0.8;
    const country = match.area.countryCode;
    if (options.countryHint && country) confidence += country === options.countryHint ? 0.08 : -0.15;
    confidence += KIND_BONUS[match.area.kind] ?? 0;
    return clamp(match.exact ? confidence : Math.min(FUZZY_CAP, confidence));
  }

  private async geocode(text: string, options: ResolveOptions): Promise<Candidates> {
    const geocoder = this.geocoder;
    const query = normalizeAreaName(text);
    if (!geocoder || !query) return { candidates: [], notice: null };
    const key: GeocodeCacheKey = {
      query,
      provider: geocoder.provider,
      countryHint: options.strictCountry ? (options.countryHint ?? '') : '',
      locale: options.locale,
      scope: geocoder.perWorkspace ? (options.organizationId ?? '') : '',
    };
    let results = await this.cache.get(key);
    if (!results) {
      if (!(await this.quota.take(options.organizationId)))
        return { candidates: [], notice: 'geocoder_quota' };
      const flightKey = JSON.stringify(key);
      let call = this.inFlight.get(flightKey);
      if (!call) {
        call = this.callGeocoder(geocoder, key, {
          text,
          countryHint: options.countryHint,
          strictCountry: options.strictCountry ?? false,
          locale: options.locale,
          orgId: options.organizationId,
        }).finally(() => this.inFlight.delete(flightKey));
        this.inFlight.set(flightKey, call);
      }
      try {
        results = await call;
      } catch (error) {
        // Best effort: an unreachable provider, an open circuit, a timeout or a limiter hiccup must not fail a
        // search that local data may still answer.
        this.logger.warn(
          {
            provider: geocoder.provider,
            code: error instanceof DomainError ? error.code : (error as Error).name,
          },
          'geocoder unavailable',
        );
        return { candidates: [], notice: 'geocoder_unavailable' };
      }
    }
    const candidates: AreaCandidate[] = [];
    for (const result of results) {
      const areaId = await this.persist(result);
      const geometry:
        | MultiPolygon
        | { type: 'Circle'; center: { lat: number; lng: number }; radiusM: number } =
        areaId && result.geometry
          ? result.geometry
          : { type: 'Circle', center: result.center, radiusM: radiusFromBbox(result) };
      let confidence = result.importance * 0.8;
      if (options.countryHint && result.countryCode)
        confidence += result.countryCode === options.countryHint ? 0.05 : -0.1;
      candidates.push({
        areaId,
        kind: result.kind,
        label: result.label,
        geometry,
        bbox: result.bbox ?? bboxOf(geometry),
        confidence: clamp(confidence),
        source: 'geocoder',
      });
    }
    return { candidates, notice: null };
  }

  private async callGeocoder(geocoder: Geocoder, key: GeocodeCacheKey, query: GeocodeQuery) {
    const results = await geocoder.geocode(query);
    const ttl = results.length > 0 ? geocoder.cacheDays * 86_400 : NEGATIVE_TTL_SECONDS;
    await this.cache.put(key, results, ttl);
    return results;
  }

  /**
   * Administrative polygon answers become shared areas (OSM data, ODbL) so later lookups stay local. Never fatal:
   * a shape PostGIS rejects leaves the answer as a point + radius.
   */
  private async persist(result: GeocodeResult): Promise<string | null> {
    if (!result.geometry || !result.persistable || !this.geocoder) return null;
    const name = result.label.split(',')[0]?.trim() ?? '';
    if (name.length < 2 || (/^\d+$/.test(name) && result.kind !== 'postal_code')) return null;
    try {
      const { id } = await this.areas.upsert({
        kind: result.kind === 'custom' ? 'locality' : result.kind,
        countryCode: result.countryCode,
        code: result.kind === 'postal_code' ? name : null,
        name: { en: name, fr: name },
        aliases: result.label === name ? [] : [result.label],
        geometry: result.geometry,
        approximate: false,
        source: this.geocoder.provider,
        sourceRef: result.sourceRef,
      });
      return id;
    } catch (error) {
      this.logger.warn(
        { provider: this.geocoder.provider, err: (error as Error).name },
        'geocoded area not stored',
      );
      return null;
    }
  }

  /** Local candidates with display geometry and parent labels, loaded in two batched queries. */
  private async toCandidates(
    entries: ReadonlyArray<{ readonly area: GeoAreaRecord; readonly confidence: number }>,
    options: ResolveOptions,
  ): Promise<AreaCandidate[]> {
    const ids = entries.map((e) => e.area.id);
    const parentIds = entries.flatMap((e) => (e.area.parentId ? [e.area.parentId] : []));
    const [geometries, parents] = await Promise.all([
      this.areas.displayGeometries(ids, options.organizationId),
      this.areas.names(parentIds, options.organizationId),
    ]);
    return entries.flatMap(({ area, confidence }) => {
      const geometry = geometries.get(area.id);
      if (!geometry) return [];
      const parent = area.parentId ? parents.get(area.parentId)?.[options.locale] : undefined;
      return [
        {
          areaId: area.id,
          kind: area.kind,
          label: [
            area.name[options.locale],
            parent ?? (area.kind === 'country' ? undefined : area.countryCode),
          ]
            .filter(Boolean)
            .join(', '),
          geometry,
          bbox: area.bbox ?? bboxOf(geometry),
          confidence,
          source: 'local' as const,
        },
      ];
    });
  }
}

const byConfidence = (candidates: readonly AreaCandidate[]) =>
  [...candidates].sort((a, b) => b.confidence - a.confidence);

/** A geocoder point's radius: half its bbox diagonal, kept between 500 m and 20 km. */
function radiusFromBbox(result: GeocodeResult): number {
  if (!result.bbox) return 2_000;
  const dLat = (result.bbox.north - result.bbox.south) * 110_574;
  const dLng =
    (result.bbox.east - result.bbox.west) * 111_320 * Math.cos((result.center.lat * Math.PI) / 180);
  return Math.round(Math.max(500, Math.min(20_000, Math.hypot(dLat, dLng) / 2)));
}

function centerOf(candidate: AreaCandidate): { lat: number; lng: number } {
  if (candidate.geometry.type === 'Circle') return candidate.geometry.center;
  return centroidOf(candidate.geometry);
}
