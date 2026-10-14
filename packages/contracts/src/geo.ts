import { z } from 'zod';

/** WGS84 point as named fields — `lat, lng` order mistakes are impossible to write. */
export const LatLngSchema = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
  .meta({ id: 'LatLng', description: 'WGS84 coordinates in decimal degrees.' });
export type LatLng = z.infer<typeof LatLngSchema>;

/** Bounding box. `west > east` is allowed: the box crosses the antimeridian. */
export const BBoxSchema = z
  .object({
    west: z.number().min(-180).max(180),
    south: z.number().min(-90).max(90),
    east: z.number().min(-180).max(180),
    north: z.number().min(-90).max(90),
  })
  .refine((box) => box.south <= box.north, { message: 'south must be ≤ north', path: ['south'] });
export type BBox = z.infer<typeof BBoxSchema>;

/** GeoJSON position: `[lng, lat]` (GeoJSON order, RFC 7946). */
export const PositionSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

const LinearRingSchema = z
  .array(PositionSchema)
  .min(4, 'A linear ring needs at least 4 positions')
  .refine(
    (ring) => {
      const first = ring[0];
      const last = ring[ring.length - 1];
      return first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1];
    },
    { message: 'A linear ring must be closed (first position = last)' },
  );

export const PolygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(LinearRingSchema).min(1),
});
export type Polygon = z.infer<typeof PolygonSchema>;

export const MultiPolygonSchema = z.object({
  type: z.literal('MultiPolygon'),
  coordinates: z.array(z.array(LinearRingSchema).min(1)).min(1),
});
export type MultiPolygon = z.infer<typeof MultiPolygonSchema>;

// ISO 3166-1 alpha-2 officially assigned codes (249), including Saint-Barthélemy (BL) and Saint-Martin (MF).
const ISO_3166_1_ALPHA_2 =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
  'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE ' +
  'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO ' +
  'MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW ' +
  'PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM ' +
  'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';
export const COUNTRY_CODES: ReadonlySet<string> = new Set(ISO_3166_1_ALPHA_2.split(' '));

export const CountryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'Expected an uppercase ISO 3166-1 alpha-2 code')
  .refine((code) => COUNTRY_CODES.has(code), { message: 'Unknown ISO 3166-1 alpha-2 country code' });
export type CountryCode = z.infer<typeof CountryCodeSchema>;
