import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import {
  CreateCustomAreaCommand,
  GeoAreaQueries,
  ResolveLocationQueryHandler,
} from './application/geo.use-cases.ts';
import { LocationResolver } from './application/location-resolver.ts';
import { GEO_AREA_REPOSITORY, GEOCODE_CACHE, GEOCODE_QUOTA, GEOCODER } from './application/ports.ts';
import { DrizzleGeoAreaRepository } from './infrastructure/drizzle-geo-area.repository.ts';
import { DrizzleGeocodeCache } from './infrastructure/drizzle-geocode-cache.ts';
import { GoogleGeocoder, NominatimGeocoder } from './infrastructure/geocoders.ts';
import { ValkeyGeocodeQuota } from './infrastructure/valkey-geocode-quota.ts';
import { GeoController } from './interface/geo.controller.ts';

/** The configured external geocoder (Strategy), or none. */
const geocoderProvider: Provider = {
  provide: GEOCODER,
  inject: [APP_ENV, NominatimGeocoder, GoogleGeocoder],
  useFactory: (env: AppEnv, nominatim: NominatimGeocoder, google: GoogleGeocoder) =>
    env.GEOCODER_PROVIDER === 'google' ? google : env.GEOCODER_PROVIDER === 'nominatim' ? nominatim : null,
};

/** Geo (BF-017): areas, location resolution, geocoding with caching, tiling for discovery. */
@Module({})
export class GeoModule {
  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: GeoModule,
      controllers: mode === 'worker' ? [] : [GeoController],
      providers: [
        { provide: GEO_AREA_REPOSITORY, useClass: DrizzleGeoAreaRepository },
        { provide: GEOCODE_CACHE, useClass: DrizzleGeocodeCache },
        { provide: GEOCODE_QUOTA, useClass: ValkeyGeocodeQuota },
        NominatimGeocoder,
        GoogleGeocoder,
        geocoderProvider,
        LocationResolver,
        ResolveLocationQueryHandler,
        GeoAreaQueries,
        CreateCustomAreaCommand,
      ],
      exports: [LocationResolver, GEO_AREA_REPOSITORY],
    };
  }
}
