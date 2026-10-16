import type { GeoAreaKind, MultiPolygon } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { geoAreas } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { AreaMatch, GeoAreaInput, GeoAreaRecord, GeoAreaRepository } from '../application/ports.ts';
import { normalizeAreaName } from '../domain/area-names.ts';
import { areaKm2, centroidOf } from '../domain/geometry.ts';

const bboxColumns = {
  west: sql<number>`ST_XMin(${geoAreas.geom}::geometry)`,
  south: sql<number>`ST_YMin(${geoAreas.geom}::geometry)`,
  east: sql<number>`ST_XMax(${geoAreas.geom}::geometry)`,
  north: sql<number>`ST_YMax(${geoAreas.geom}::geometry)`,
};

const recordColumns = {
  id: geoAreas.id,
  kind: geoAreas.kind,
  countryCode: geoAreas.countryCode,
  code: geoAreas.code,
  name: geoAreas.name,
  aliases: geoAreas.aliases,
  parentId: geoAreas.parentId,
  approximate: geoAreas.approximate,
  source: geoAreas.source,
  sourceRef: geoAreas.sourceRef,
  areaKm2: geoAreas.areaKm2,
  centroid: geoAreas.centroid,
  organizationId: geoAreas.organizationId,
  ...bboxColumns,
};

const toRecord = (row: Record<string, unknown>): GeoAreaRecord => {
  const r = row as unknown as GeoAreaRecord & { west: number; south: number; east: number; north: number };
  return {
    id: r.id,
    kind: r.kind,
    countryCode: r.countryCode,
    code: r.code,
    name: r.name,
    aliases: r.aliases,
    parentId: r.parentId,
    approximate: r.approximate,
    source: r.source,
    sourceRef: r.sourceRef,
    areaKm2: r.areaKm2,
    centroid: r.centroid,
    bbox:
      r.west === null || r.west === undefined
        ? null
        : { west: Number(r.west), south: Number(r.south), east: Number(r.east), north: Number(r.north) },
    organizationId: r.organizationId,
  };
};

/** Every name and alias, normalized and deduplicated. */
export function normalizedNamesOf(area: Pick<GeoAreaInput, 'name' | 'aliases' | 'code'>): string[] {
  const names = [area.name.en, area.name.fr, area.name.local, ...area.aliases, area.code]
    .filter((n): n is string => Boolean(n))
    .map(normalizeAreaName)
    .filter(Boolean);
  return [...new Set(names)].sort();
}

const visibleTo = (organizationId: string | null) =>
  organizationId
    ? or(isNull(geoAreas.organizationId), eq(geoAreas.organizationId, organizationId))
    : isNull(geoAreas.organizationId);

@Injectable()
export class DrizzleGeoAreaRepository implements GeoAreaRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async upsert(area: GeoAreaInput): Promise<{ readonly id: string; readonly changed: boolean }> {
    const executor = getExecutor(this.db);
    const parent = area.parentSourceRef
      ? (
          await executor
            .select({ id: geoAreas.id })
            .from(geoAreas)
            .where(and(eq(geoAreas.source, area.source), eq(geoAreas.sourceRef, area.parentSourceRef)))
        )[0]
      : undefined;
    // An unresolved parent would silently detach the area on re-import: packs must yield parents first.
    if (area.parentSourceRef && !parent) throw new Error(`Parent ${area.parentSourceRef} not imported yet`);
    const names = normalizedNamesOf(area);
    const values = {
      kind: area.kind,
      countryCode: area.countryCode,
      code: area.code,
      name: area.name,
      aliases: [...area.aliases],
      normalizedNames: names,
      searchText: names.join(' '),
      parentId: parent?.id ?? null,
      geom: area.geometry,
      centroid: centroidOf(area.geometry),
      approximate: area.approximate,
      source: area.source,
      sourceRef: area.sourceRef,
      areaKm2: areaKm2(area.geometry),
      organizationId: area.organizationId ?? null,
    };
    if (!area.sourceRef) {
      const [row] = await executor.insert(geoAreas).values(values).returning({ id: geoAreas.id });
      return { id: row?.id as string, changed: true };
    }
    const distinct = (column: string) => sql.raw(`geo_areas.${column} IS DISTINCT FROM excluded.${column}`);
    const [written] = await executor
      .insert(geoAreas)
      .values(values)
      .onConflictDoUpdate({
        target: [geoAreas.source, geoAreas.sourceRef],
        set: {
          kind: sql`excluded.kind`,
          countryCode: sql`excluded.country_code`,
          code: sql`excluded.code`,
          name: sql`excluded.name`,
          aliases: sql`excluded.aliases`,
          normalizedNames: sql`excluded.normalized_names`,
          searchText: sql`excluded.search_text`,
          parentId: sql`excluded.parent_id`,
          geom: sql`excluded.geom`,
          centroid: sql`excluded.centroid`,
          approximate: sql`excluded.approximate`,
          areaKm2: sql`excluded.area_km2`,
        },
        // Only the owner's row is ever updated (a source ref never moves between workspaces), and only on change.
        setWhere: sql`geo_areas.organization_id IS NOT DISTINCT FROM excluded.organization_id AND (${sql.join(
          [
            ...['kind', 'country_code', 'code', 'name', 'aliases', 'parent_id', 'approximate'].map(distinct),
            sql.raw('ST_AsBinary(geo_areas.geom) IS DISTINCT FROM ST_AsBinary(excluded.geom)'),
          ],
          sql` OR `,
        )})`,
      })
      .returning({ id: geoAreas.id });
    if (written) return { id: written.id, changed: true };
    const [existing] = await executor
      .select({ id: geoAreas.id, organizationId: geoAreas.organizationId })
      .from(geoAreas)
      .where(and(eq(geoAreas.source, area.source), eq(geoAreas.sourceRef, area.sourceRef)));
    if (!existing || existing.organizationId !== (area.organizationId ?? null)) {
      throw new Error(`Area ${area.source}:${area.sourceRef} belongs to another owner`);
    }
    return { id: existing.id, changed: false };
  }

  async match(
    text: string,
    filter: { organizationId: string | null; kind?: GeoAreaKind; countryCode?: string; limit: number },
  ): Promise<AreaMatch[]> {
    const q = normalizeAreaName(text);
    if (!q) return [];
    const exact = sql<boolean>`${geoAreas.normalizedNames} @> ARRAY[${q}]::text[]`;
    const similarity = sql<number>`word_similarity(${q}, ${geoAreas.searchText})`;
    const rows = await getExecutor(this.db)
      .select({ ...recordColumns, exact, similarity })
      .from(geoAreas)
      .where(
        and(
          visibleTo(filter.organizationId),
          filter.kind ? eq(geoAreas.kind, filter.kind) : undefined,
          filter.countryCode ? eq(geoAreas.countryCode, filter.countryCode) : undefined,
          // Both branches use an index (GIN on normalized_names, trigram GIN on search_text).
          sql`(${exact} OR ${q} <% ${geoAreas.searchText})`,
        ),
      )
      .orderBy(sql`${exact} DESC`, sql`${similarity} DESC`, geoAreas.areaKm2)
      .limit(filter.limit);
    return rows.map((row) => ({
      area: toRecord(row),
      exact: Boolean(row.exact),
      score: row.exact ? 1 : Number(row.similarity),
    }));
  }

  async findByCode(kind: GeoAreaKind, code: string, countryCode: string): Promise<GeoAreaRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select(recordColumns)
      .from(geoAreas)
      .where(
        and(
          eq(geoAreas.kind, kind),
          eq(geoAreas.code, code),
          eq(geoAreas.countryCode, countryCode),
          isNull(geoAreas.organizationId),
        ),
      )
      .limit(1);
    return row ? toRecord(row) : undefined;
  }

  async getById(id: string, organizationId: string | null): Promise<GeoAreaRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select(recordColumns)
      .from(geoAreas)
      .where(and(eq(geoAreas.id, id), visibleTo(organizationId)));
    return row ? toRecord(row) : undefined;
  }

  async geometryOf(id: string, organizationId: string | null): Promise<MultiPolygon | undefined> {
    const [row] = await getExecutor(this.db)
      .select({ geom: geoAreas.geom })
      .from(geoAreas)
      .where(and(eq(geoAreas.id, id), visibleTo(organizationId)));
    return row?.geom as MultiPolygon | undefined;
  }

  async displayGeometries(ids: readonly string[], organizationId: string | null) {
    if (ids.length === 0) return new Map<string, MultiPolygon>();
    const rows = await getExecutor(this.db)
      .select({
        id: geoAreas.id,
        geojson: sql<string>`ST_AsGeoJSON(ST_Multi(ST_SimplifyPreserveTopology(${geoAreas.geom}::geometry, 0.0001)), 6)`,
      })
      .from(geoAreas)
      .where(and(inArray(geoAreas.id, [...ids]), visibleTo(organizationId)));
    return new Map(rows.map((r) => [r.id, JSON.parse(r.geojson) as MultiPolygon]));
  }

  async names(ids: readonly string[], organizationId: string | null) {
    if (ids.length === 0) return new Map<string, GeoAreaRecord['name']>();
    const rows = await getExecutor(this.db)
      .select({ id: geoAreas.id, name: geoAreas.name })
      .from(geoAreas)
      .where(and(inArray(geoAreas.id, [...new Set(ids)]), visibleTo(organizationId)));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async invalidReason(geometry: MultiPolygon): Promise<string | null> {
    const result = await getExecutor(this.db).execute<{ valid: boolean; reason: string }>(
      sql`SELECT ST_IsValid(g) AS valid, ST_IsValidReason(g) AS reason
          FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326) AS g) AS input`,
    );
    const [row] = result as unknown as Array<{ valid: boolean; reason: string }>;
    return row?.valid ? null : (row?.reason ?? 'invalid geometry');
  }

  async countCustom(organizationId: string): Promise<number> {
    const [row] = await getExecutor(this.db)
      .select({ n: sql<number>`count(*)::int` })
      .from(geoAreas)
      .where(and(eq(geoAreas.organizationId, organizationId), eq(geoAreas.source, 'custom')));
    return row?.n ?? 0;
  }
}
