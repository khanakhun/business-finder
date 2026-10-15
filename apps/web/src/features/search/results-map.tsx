'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import type { BusinessListItem } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { useMutation } from '@tanstack/react-query';
import { PentagonIcon, SquareDashedIcon, XIcon } from 'lucide-react';
import { setWorkerUrl } from 'maplibre-gl';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import MapGL, {
  AttributionControl,
  Layer,
  type MapLayerMouseEvent,
  type MapRef,
  NavigationControl,
  Source,
} from 'react-map-gl/maplibre';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { apiClient } from '@/lib/api.ts';
import { getToast } from '@/lib/toast.tsx';
import { useArea, useSearchState } from './hooks.tsx';

// Copied to /public by scripts/next.mjs: the bundle cannot resolve MapLibre's worker next to its module.
setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

const STYLE = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/liberty';
const LAGOON = '#0b7480';
const BUOY = '#c98a04';

type Point = [lng: number, lat: number];
type DrawMode = 'rectangle' | 'polygon';

const ring = (mode: DrawMode, points: readonly Point[]): Point[] => {
  if (mode === 'rectangle' && points.length === 2) {
    const [[x1, y1], [x2, y2]] = points as [Point, Point];
    return [
      [x1, y1],
      [x2, y1],
      [x2, y2],
      [x1, y2],
      [x1, y1],
    ];
  }
  return points.length >= 3 ? [...points, points[0] as Point] : [...points];
};

/** The results on a map (BF-023): clustered markers synced with the table, the area outline, a draw tool. */
export function ResultsMap({
  items,
  highlightedId,
  onHover,
  onOpen,
}: {
  readonly items: readonly BusinessListItem[];
  readonly highlightedId: string | null;
  readonly onHover: (id: string | null) => void;
  readonly onOpen: (item: BusinessListItem) => void;
}) {
  const t = useTranslations('search.map');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const [state, setState] = useSearchState();
  const area = useArea(state.area);
  const mapRef = React.useRef<MapRef>(null);
  const [draw, setDraw] = React.useState<{ mode: DrawMode; points: Point[] } | null>(null);

  const located = items.filter((item) => item.location);
  const byId = React.useMemo(() => new Map<string, BusinessListItem>(items.map((i) => [i.id, i])), [items]);
  const points = React.useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: located.map((item) => ({
        type: 'Feature' as const,
        properties: { id: item.id, name: item.displayName },
        geometry: { type: 'Point' as const, coordinates: [item.location?.lng ?? 0, item.location?.lat ?? 0] },
      })),
    }),
    [located],
  );

  // Fit to the results (or the area) when they change.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const bbox = area.data?.properties.bbox;
    if (bbox) {
      map.fitBounds(
        [
          [bbox.west, bbox.south],
          [bbox.east, bbox.north],
        ],
        { padding: 40, duration: 0 },
      );
      return;
    }
    if (located.length === 0) return;
    const lngs = located.map((i) => i.location?.lng ?? 0);
    const lats = located.map((i) => i.location?.lat ?? 0);
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 40, maxZoom: 15, duration: 0 },
    );
  }, [located, area.data]);

  const save = useMutation({
    mutationFn: async (coordinates: Point[]) =>
      (
        await apiClient().POST('/v1/geo/areas', {
          body: {
            name: t('areaDefault', {
              date: format.dateTime(new Date(), { dateStyle: 'medium', timeStyle: 'short' }),
            }),
            geometry: { type: 'Polygon', coordinates: [coordinates] },
          } as never,
        })
      ).data as { id: string },
    onSuccess: async (created) => {
      setDraw(null);
      await setState({ area: created.id, near: null, radiusKm: null });
      (await getToast()).success(t('areaSaved'));
    },
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });

  const onClick = (event: MapLayerMouseEvent) => {
    if (draw) {
      const point: Point = [event.lngLat.lng, event.lngLat.lat];
      const next = [...draw.points, point];
      if (draw.mode === 'rectangle' && next.length === 2) {
        save.mutate(ring('rectangle', next));
        return;
      }
      setDraw({ ...draw, points: next });
      return;
    }
    const feature = event.features?.[0];
    if (!feature) return;
    if (feature.layer.id === 'clusters') {
      const center = (feature.geometry as { coordinates: Point }).coordinates;
      mapRef.current?.easeTo({ center, zoom: (mapRef.current.getZoom() ?? 10) + 2 });
      return;
    }
    const item = byId.get(String(feature.properties?.id));
    if (item) onOpen(item);
  };

  const drawn = draw ? ring(draw.mode, draw.points) : [];
  return (
    <section aria-label={t('label')} className="relative min-h-96 flex-1 overflow-hidden rounded-lg border">
      <MapGL
        ref={mapRef}
        mapStyle={STYLE}
        initialViewState={{ longitude: -62.84, latitude: 17.9, zoom: 12 }}
        attributionControl={false}
        interactiveLayerIds={draw ? [] : ['clusters', 'points']}
        {...(draw ? { cursor: 'crosshair' } : {})}
        doubleClickZoom={!draw}
        onClick={onClick}
        onDblClick={() => {
          if (draw?.mode === 'polygon' && draw.points.length >= 3) save.mutate(ring('polygon', draw.points));
        }}
        onMouseMove={(event) => {
          if (draw) return;
          const id = event.features?.find((f) => f.layer.id === 'points')?.properties?.id;
          onHover(id ? String(id) : null);
        }}
        onMouseLeave={() => onHover(null)}
        style={{ position: 'absolute', inset: 0 }}
      >
        <NavigationControl position="top-right" />
        {/* The style carries the OpenStreetMap / OpenFreeMap attribution. */}
        <AttributionControl compact />
        {area.data ? (
          <Source id="area" type="geojson" data={area.data}>
            <Layer id="area-fill" type="fill" paint={{ 'fill-color': LAGOON, 'fill-opacity': 0.06 }} />
            <Layer id="area-line" type="line" paint={{ 'line-color': LAGOON, 'line-width': 2 }} />
          </Source>
        ) : null}
        <Source id="results" type="geojson" data={points} cluster clusterRadius={40} clusterMaxZoom={15}>
          <Layer
            id="clusters"
            type="circle"
            filter={['has', 'point_count']}
            paint={{
              'circle-color': LAGOON,
              'circle-opacity': 0.85,
              'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 50, 24],
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            }}
          />
          <Layer
            id="cluster-count"
            type="symbol"
            filter={['has', 'point_count']}
            layout={{ 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12 }}
            paint={{ 'text-color': '#ffffff' }}
          />
          <Layer
            id="points"
            type="circle"
            filter={['!', ['has', 'point_count']]}
            paint={{
              'circle-color': ['case', ['==', ['get', 'id'], highlightedId ?? ''], BUOY, LAGOON],
              'circle-radius': ['case', ['==', ['get', 'id'], highlightedId ?? ''], 9, 6],
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            }}
          />
        </Source>
        {drawn.length > 1 ? (
          <Source
            id="draw"
            type="geojson"
            data={{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: drawn } }}
          >
            <Layer
              id="draw-line"
              type="line"
              paint={{ 'line-color': BUOY, 'line-width': 2, 'line-dasharray': [2, 1] }}
            />
          </Source>
        ) : null}
      </MapGL>
      <div className="absolute top-2 left-2 flex flex-col gap-1.5 rounded-md bg-surface/95 p-1.5 shadow-sm">
        {draw ? (
          <>
            <p className="max-w-56 px-1 text-xs" role="status">
              {draw.mode === 'rectangle' ? t('drawRectangleHelp') : t('drawHelp')}
            </p>
            <div className="flex gap-1">
              {draw.mode === 'polygon' ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={draw.points.length < 3 || save.isPending}
                  onClick={() => save.mutate(ring('polygon', draw.points))}
                >
                  {t('drawFinish')}
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="ghost" onClick={() => setDraw(null)}>
                <XIcon aria-hidden />
                {t('drawCancel')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="px-1 text-xs font-medium">{t('draw')}</span>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setDraw({ mode: 'rectangle', points: [] })}
              >
                <SquareDashedIcon aria-hidden />
                {t('drawRectangle')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setDraw({ mode: 'polygon', points: [] })}
              >
                <PentagonIcon aria-hidden />
                {t('drawPolygon')}
              </Button>
            </div>
          </>
        )}
      </div>
      <p className="absolute bottom-10 left-2 rounded bg-surface/90 px-2 py-0.5 text-xs">
        {t('listAlternative')}
        {items.length > located.length ? ` ${t('noLocation', { count: items.length - located.length })}` : ''}
      </p>
    </section>
  );
}
