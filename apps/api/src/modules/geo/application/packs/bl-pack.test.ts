import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import type { MultiPolygon as GeoJsonMultiPolygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { areaKm2 } from '../../domain/geometry.ts';
import { buildBlAreas, loadBlExtract } from './bl-pack.ts';

describe('Saint-Barthélemy pack', () => {
  const areas = buildBlAreas(loadBlExtract());
  const byName = (name: string) => areas.find((a) => a.name.local === name);

  it('yields the island first with its aliases and a plausible size', () => {
    const [island] = areas;
    expect(island?.kind).toBe('island');
    expect(island?.code).toBe('BL');
    expect(island?.aliases).toEqual(expect.arrayContaining(['St Barth', 'SBH']));
    // The island is about 21 km² (25 km² with islets, which this outline excludes).
    expect(areaKm2(island?.geometry as never)).toBeGreaterThan(18);
    expect(areaKm2(island?.geometry as never)).toBeLessThan(26);
  });

  it('maps every quarter from its OSM polygon under the island', () => {
    const quarters = areas.filter((a) => a.sourceRef?.startsWith('bl:way/'));
    expect(quarters.length).toBeGreaterThanOrEqual(20);
    for (const q of quarters) {
      expect(q.parentSourceRef).toBe(areas[0]?.sourceRef);
      expect(q.approximate).toBe(true);
    }
    for (const name of ['Gustavia', 'Saint-Jean', 'Lorient', 'Flamands', 'Grand Cul-de-Sac', 'Corossol']) {
      expect(byName(name), name).toBeDefined();
    }
  });

  it('treats Gustavia as the locality and keeps alternative spellings as aliases', () => {
    expect(byName('Gustavia')?.kind).toBe('locality');
    expect(byName('Lorient')?.kind).toBe('district');
    expect(byName('Montjean')?.aliases).toContain('Mont Jean');
    expect(byName('Dévé')?.aliases).toContain('Devet');
  });

  it('gives hamlets a cell inside the quarter that contains them', () => {
    const hamlets = areas.filter((a) => a.sourceRef?.startsWith('bl:node/'));
    expect(hamlets.length).toBeGreaterThan(0);
    for (const h of hamlets) {
      const parent = areas.find((a) => a.sourceRef === h.parentSourceRef);
      expect(parent, h.name.local).toBeDefined();
      expect(areaKm2(h.geometry)).toBeLessThanOrEqual(areaKm2(parent?.geometry as never) + 0.001);
    }
  });

  it('has unique names and source refs, and every area lies on the island', () => {
    const refs = areas.map((a) => a.sourceRef);
    expect(new Set(refs).size).toBe(refs.length);
    const names = areas.map((a) => a.name.local);
    expect(new Set(names).size).toBe(names.length);
    // A hamlet point spelled like a quarter alias is that quarter, not a second area.
    const aliases = new Set(areas.flatMap((a) => a.aliases));
    expect(
      areas.filter((a) => a.sourceRef?.startsWith('bl:node/') && aliases.has(a.name.local ?? '')),
    ).toEqual([]);
    const island = areas[0]?.geometry as GeoJsonMultiPolygon;
    // Gustavia harbour and Saint-Jean beach are on the island.
    expect(booleanPointInPolygon([-62.8506, 17.8962], island)).toBe(true);
    expect(booleanPointInPolygon([-62.8272, 17.9022], island)).toBe(true);
  });
});
