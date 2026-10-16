import { InvalidValueError } from '../errors.ts';

/** WGS84 coordinates in decimal degrees. */
export class GeoPoint {
  private constructor(
    readonly lat: number,
    readonly lng: number,
  ) {}

  static of(lat: number, lng: number): GeoPoint {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90)
      throw new InvalidValueError('location', 'Latitude out of range.');
    if (!Number.isFinite(lng) || lng < -180 || lng > 180)
      throw new InvalidValueError('location', 'Longitude out of range.');
    // (0, 0) is "Null Island": almost always a missing value encoded as zeros.
    if (lat === 0 && lng === 0)
      throw new InvalidValueError('location', 'Coordinates (0, 0) are not a real location.');
    return new GeoPoint(lat, lng);
  }

  toJSON(): { lat: number; lng: number } {
    return { lat: this.lat, lng: this.lng };
  }
}
