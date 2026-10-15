import { createHash } from 'node:crypto';
import {
  ConflictError,
  type CreateCustomAreaRequest,
  type GeoAreaFeature,
  type GeoAreaList,
  type GeoAreaQuery,
  type GeoAreaSummary,
  type Locale,
  type LocationResolution,
  NotFoundError,
  type ResolveLocationQuery,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { AuditLogger, WorkspaceDefaults } from '../../workspace/index.ts';
import { areaKm2, toMultiPolygon } from '../domain/geometry.ts';
import { LocationResolver } from './location-resolver.ts';
import { GEO_AREA_REPOSITORY, type GeoAreaRecord, type GeoAreaRepository } from './ports.ts';

/** Largest custom area a workspace can draw (an island chain, not a continent). */
const MAX_CUSTOM_AREA_KM2 = 50_000;
/** Custom areas one workspace can keep. */
const MAX_CUSTOM_AREAS = 200;

export function toSummary(area: GeoAreaRecord, locale: Locale, parentName?: string): GeoAreaSummary {
  const name = area.name[locale];
  return {
    id: area.id,
    kind: area.kind,
    countryCode: area.countryCode,
    code: area.code,
    name: { en: area.name.en, fr: area.name.fr, ...(area.name.local ? { local: area.name.local } : {}) },
    label: [name, parentName ?? (area.kind === 'country' ? undefined : area.countryCode)]
      .filter(Boolean)
      .join(', '),
    parentId: area.parentId,
    approximate: area.approximate,
    source: area.source,
    areaKm2: area.areaKm2,
    centroid: area.centroid,
    bbox: area.bbox,
  };
}

@Injectable()
export class ResolveLocationQueryHandler {
  constructor(
    private readonly resolver: LocationResolver,
    private readonly defaults: WorkspaceDefaults,
  ) {}

  async execute(auth: AuthContext, query: ResolveLocationQuery): Promise<LocationResolution> {
    const countryHint = query.country ?? (auth.orgId ? await this.defaults.countryHint(auth.orgId) : null);
    return this.resolver.resolve(query.q, {
      locale: query.locale,
      countryHint,
      strictCountry: query.country !== undefined,
      organizationId: auth.orgId,
    });
  }
}

@Injectable()
export class GeoAreaQueries {
  constructor(@Inject(GEO_AREA_REPOSITORY) private readonly areas: GeoAreaRepository) {}

  /** Typeahead (names and aliases, accent-insensitive), global areas and the workspace's own. */
  async search(auth: AuthContext, query: GeoAreaQuery): Promise<GeoAreaList> {
    if (!query.q) return { items: [] };
    const matches = await this.areas.match(query.q, {
      organizationId: auth.orgId,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.country ? { countryCode: query.country } : {}),
      limit: query.limit,
    });
    const parents = await this.areas.names(
      matches.flatMap((m) => (m.area.parentId ? [m.area.parentId] : [])),
      auth.orgId,
    );
    return {
      items: matches.map((m) =>
        toSummary(
          m.area,
          query.locale,
          m.area.parentId ? parents.get(m.area.parentId)?.[query.locale] : undefined,
        ),
      ),
    };
  }

  async feature(auth: AuthContext, id: string, locale: Locale): Promise<GeoAreaFeature> {
    const area = await this.areas.getById(id, auth.orgId);
    const geometry = area ? await this.areas.geometryOf(id, auth.orgId) : undefined;
    if (!area || !geometry) throw new NotFoundError('GeoArea', id);
    const { id: _id, ...properties } = toSummary(area, locale);
    return { type: 'Feature', id: area.id, geometry, properties };
  }
}

/** A polygon drawn on the map (BF-023): a `custom` area only the workspace sees. */
@Injectable()
export class CreateCustomAreaCommand {
  constructor(
    @Inject(GEO_AREA_REPOSITORY) private readonly areas: GeoAreaRepository,
    private readonly audit: AuditLogger,
  ) {}

  async execute(auth: AuthContext, request: CreateCustomAreaRequest): Promise<GeoAreaSummary> {
    if (!auth.orgId) throw new Error('Geo route reached without an active workspace');
    const geometry = toMultiPolygon(request.geometry);
    // Validity first: a self-intersecting outline's signed area can cancel out and slip past the size check.
    const invalid = await this.areas.invalidReason(geometry);
    if (invalid) {
      throw new ValidationError('The area outline is not a valid polygon.', [
        { path: ['geometry'], message: invalid },
      ]);
    }
    const km2 = areaKm2(geometry);
    if (!(km2 > 0) || km2 > MAX_CUSTOM_AREA_KM2) {
      throw new ValidationError('The area is empty or too large.', [
        { path: ['geometry'], message: `Between 0 and ${MAX_CUSTOM_AREA_KM2} km²` },
      ]);
    }
    if ((await this.areas.countCustom(auth.orgId)) >= MAX_CUSTOM_AREAS) {
      throw new ConflictError(`A workspace can keep up to ${MAX_CUSTOM_AREAS} custom areas.`);
    }
    const { id } = await this.areas.upsert({
      kind: 'custom',
      countryCode: null,
      code: null,
      name: { en: request.name, fr: request.name },
      aliases: [],
      geometry,
      approximate: false,
      source: 'custom',
      // Same workspace + name + outline → same area: a retried request does not create a duplicate.
      sourceRef: `custom:${createHash('sha256')
        .update(JSON.stringify([auth.orgId, request.name, geometry]))
        .digest('hex')}`,
      organizationId: auth.orgId,
    });
    await this.audit.record({ action: 'geo.area_created', entityType: 'geo_area', entityId: id });
    const area = await this.areas.getById(id, auth.orgId);
    if (!area) throw new Error(`Area ${id} missing after insert`);
    return toSummary(area, 'en');
  }
}
