// Public surface of the geo module: other modules import only from here.
export { LocationResolver, type ResolveOptions } from './application/location-resolver.ts';
export { GEO_AREA_REPOSITORY, type GeoAreaRecord, type GeoAreaRepository } from './application/ports.ts';
export { type BBoxTile, subdivide, tileAsBBoxes, tileAsCircles } from './domain/tiling.ts';
export { GeoModule } from './geo.module.ts';
