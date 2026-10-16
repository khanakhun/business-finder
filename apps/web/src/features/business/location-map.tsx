'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { setWorkerUrl } from 'maplibre-gl';
import MapGL, { AttributionControl, Marker, NavigationControl } from 'react-map-gl/maplibre';
import { publicEnv } from '@/lib/public-env.ts';

// Copied to /public by scripts/next.mjs (see features/search/results-map.tsx).
setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

/** Where the business is (one marker; loaded only when the Overview tab shows a location). */
export function LocationMap({
  lat,
  lng,
  label,
}: {
  readonly lat: number;
  readonly lng: number;
  readonly label: string;
}) {
  return (
    <div className="h-56 overflow-hidden rounded-lg border">
      <MapGL
        initialViewState={{ latitude: lat, longitude: lng, zoom: 15 }}
        mapStyle={publicEnv().mapStyleUrl}
        attributionControl={false}
        style={{ width: '100%', height: '100%' }}
      >
        <NavigationControl position="top-right" showCompass={false} />
        <AttributionControl compact position="bottom-right" />
        <Marker latitude={lat} longitude={lng} anchor="bottom">
          <span
            role="img"
            aria-label={label}
            className="block size-4 rounded-full border-2 border-white bg-lagoon shadow"
          />
        </Marker>
      </MapGL>
    </div>
  );
}
