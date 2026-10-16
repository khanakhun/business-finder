// Geohash cells for blocking and advisory-lock keys (BF-016). Standard base-32 geohash; neighbours are found by
// encoding points one cell away, which is exact enough for 6-character cells (~1.2 km × 0.6 km).

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohashEncode(lat: number, lng: number, precision = 6): string {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = '';
  let bits = 0;
  let value = 0;
  let evenBit = true;
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        value = (value << 1) | 1;
        lngMin = mid;
      } else {
        value <<= 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        value = (value << 1) | 1;
        latMin = mid;
      } else {
        value <<= 1;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    if (++bits === 5) {
      hash += BASE32[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}

/** Cell size in degrees for a precision (latitude height, longitude width). */
export function geohashCellSize(precision: number): { lat: number; lng: number } {
  const lngBits = Math.ceil((precision * 5) / 2);
  const latBits = Math.floor((precision * 5) / 2);
  return { lat: 180 / 2 ** latBits, lng: 360 / 2 ** lngBits };
}

/** The cell of a point and its 8 neighbours (deduplicated near the poles and the antimeridian), sorted. */
export function geohashWithNeighbours(lat: number, lng: number, precision = 6): string[] {
  const size = geohashCellSize(precision);
  // Step from the cell's centre, never from the point: a point on a cell edge plus one cell width can land exactly on
  // the next edge and skip a neighbour.
  const own = geohashEncode(lat, lng, precision);
  const center = geohashCenter(own);
  const cells = new Set<string>([own]);
  for (const dLat of [-1, 0, 1]) {
    for (const dLng of [-1, 0, 1]) {
      const pLat = Math.max(-90, Math.min(90 - 1e-9, center.lat + dLat * size.lat));
      let pLng = center.lng + dLng * size.lng;
      if (pLng >= 180) pLng -= 360;
      if (pLng < -180) pLng += 360;
      cells.add(geohashEncode(pLat, pLng, precision));
    }
  }
  return [...cells].sort();
}

/** Centre of a geohash cell. */
export function geohashCenter(hash: string): { lat: number; lng: number } {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let evenBit = true;
  for (const char of hash) {
    const value = BASE32.indexOf(char);
    for (let bit = 4; bit >= 0; bit--) {
      const on = (value >> bit) & 1;
      if (evenBit) {
        const mid = (lngMin + lngMax) / 2;
        if (on) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (on) latMin = mid;
        else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }
  return { lat: (latMin + latMax) / 2, lng: (lngMin + lngMax) / 2 };
}

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
