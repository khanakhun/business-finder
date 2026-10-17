'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import type { GeoAreaFeature } from '@bf/contracts';
import { useQueries } from '@tanstack/react-query';
import { setWorkerUrl } from 'maplibre-gl';
import * as React from 'react';
import MapGL, { AttributionControl, Layer, NavigationControl, Source } from 'react-map-gl/maplibre';
import { apiClient } from '@/lib/api.ts';
import { publicEnv } from '@/lib/public-env.ts';

// Copied to /public by scripts/next.mjs (see features/search/results-map.tsx).
setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

/** A choropleth of a rate per area (BF-058): darker is higher; areas under the minimum sample are hatched grey. */
export function AreaMap({
  values,
  label,
}: {
  /** Area id → rate (0–1) and its sample size. */
  readonly values: ReadonlyMap<string, { rate: number | null; n: number }>;
  readonly label: string;
}) {
  const ids = [...values.keys()].slice(0, 40);
  const areas = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['geo', 'area', id],
      queryFn: async () => {
        const { data, error } = await apiClient().GET('/v1/geo/areas/{id}', { params: { path: { id } } });
        if (error || !data) throw error ?? new Error('No area');
        return data as GeoAreaFeature;
      },
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  const features = areas.flatMap((area) => (area.data ? [area.data] : []));
  const max = Math.max(0.0001, ...[...values.values()].map((v) => v.rate ?? 0));
  const collection = React.useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: features.map((feature) => {
        const value = values.get(feature.id);
        return {
          ...feature,
          properties: {
            name: feature.properties.name,
            intensity: value && value.n >= 30 && value.rate !== null ? value.rate / max : -1,
          },
        };
      }),
    }),
    [features, values, max],
  );
  const bounds = React.useMemo(() => {
    const boxes = features.flatMap((feature) => (feature.properties.bbox ? [feature.properties.bbox] : []));
    if (boxes.length === 0) return null;
    return [
      Math.min(...boxes.map((b) => b.west)),
      Math.min(...boxes.map((b) => b.south)),
      Math.max(...boxes.map((b) => b.east)),
      Math.max(...boxes.map((b) => b.north)),
    ] as [number, number, number, number];
  }, [features]);
  if (!bounds) return null;
  return (
    <div className="h-72 overflow-hidden rounded-lg border" role="img" aria-label={label}>
      <MapGL
        initialViewState={{ bounds, fitBoundsOptions: { padding: 24 } }}
        mapStyle={publicEnv().mapStyleUrl}
        attributionControl={false}
        style={{ width: '100%', height: '100%' }}
      >
        <NavigationControl position="top-right" showCompass={false} />
        <AttributionControl compact position="bottom-right" />
        <Source id="analytics-areas" type="geojson" data={collection}>
          <Layer
            id="analytics-areas-fill"
            type="fill"
            paint={{
              'fill-color': [
                'case',
                ['<', ['get', 'intensity'], 0],
                '#9ca3af',
                ['interpolate', ['linear'], ['get', 'intensity'], 0, '#cffafe', 1, '#0e7490'],
              ],
              'fill-opacity': 0.6,
            }}
          />
          <Layer id="analytics-areas-line" type="line" paint={{ 'line-color': '#0e7490', 'line-width': 1 }} />
        </Source>
      </MapGL>
    </div>
  );
}
