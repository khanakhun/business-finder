import type { MultiPolygon } from '@bf/contracts';
import { toMultiPolygon } from '../../domain/geometry.ts';
import type { GeoAreaInput } from '../ports.ts';
import { readFeatures } from './geojson-seq.ts';
import type { GeoPack, PackOptions } from './types.ts';

const polygonal = (geometry: { type: string; coordinates: unknown }): MultiPolygon | null =>
  geometry.type === 'Polygon' || geometry.type === 'MultiPolygon' ? toMultiPolygon(geometry as never) : null;

const requireFile = (options: PackOptions, pack: string): string => {
  if (!options.file)
    throw new Error(`The ${pack} pack needs --file <path to a GeoJSONSeq export> (see its README).`);
  return options.file;
};

/** Dutch 4-digit postcode areas (CBS/PDOK open data, CC BY 4.0). Property `postcode` or `pc4`. */
export const nlPc4Pack: GeoPack = {
  name: 'nl-pc4',
  source: 'CBS / PDOK postcode-4 areas (CC BY 4.0) — export to GeoJSONSeq, WGS84',
  async *areas(options) {
    for await (const feature of readFeatures(requireFile(options, 'nl-pc4'))) {
      const code = String(
        feature.properties.postcode ?? feature.properties.pc4 ?? feature.properties.PC4 ?? '',
      );
      const geometry = polygonal(feature.geometry);
      if (!/^\d{4}$/.test(code) || !geometry) continue;
      yield {
        kind: 'postal_code',
        countryCode: 'NL',
        code,
        name: { en: code, fr: code },
        aliases: [],
        geometry,
        approximate: false,
        source: 'pdok',
        sourceRef: `nl-pc4:${code}`,
      } satisfies GeoAreaInput;
    }
  },
};

/** US ZIP Code Tabulation Areas (Census TIGER/Line, public domain). Property `ZCTA5CE20` (or `ZCTA5CE10`). */
export const usZctaPack: GeoPack = {
  name: 'us-zcta',
  source: 'U.S. Census Bureau TIGER/Line ZCTA5 (public domain) — export to GeoJSONSeq, WGS84',
  async *areas(options) {
    for await (const feature of readFeatures(requireFile(options, 'us-zcta'))) {
      const code = String(
        feature.properties.ZCTA5CE20 ?? feature.properties.ZCTA5CE10 ?? feature.properties.zcta ?? '',
      );
      const geometry = polygonal(feature.geometry);
      if (!/^\d{5}$/.test(code) || !geometry) continue;
      if (options.prefix && !code.startsWith(options.prefix)) continue;
      yield {
        kind: 'postal_code',
        countryCode: 'US',
        code,
        name: { en: code, fr: code },
        aliases: [],
        geometry,
        approximate: false,
        source: 'census',
        sourceRef: `us-zcta:${code}`,
      } satisfies GeoAreaInput;
    }
  },
};
