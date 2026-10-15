import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** RFC 8142 record separator (built from its code point: Biome rewrites escapes into literal characters). */
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

/**
 * Streams a GeoJSON Text Sequence (RFC 8142, `ogr2ogr -f GeoJSONSeq`) or newline-delimited GeoJSON, one feature
 * per line, so national packs (tens of thousands of polygons) never load whole into memory.
 */
export async function* readFeatures(
  path: string,
): AsyncGenerator<{ properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }> {
  const lines = createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const raw of lines) {
    const line = (raw.startsWith(RECORD_SEPARATOR) ? raw.slice(1) : raw).trim();
    if (!line) continue;
    const feature = JSON.parse(line) as {
      type?: string;
      properties?: Record<string, unknown>;
      geometry?: { type: string; coordinates: unknown };
    };
    if (feature.type !== 'Feature' || !feature.geometry) continue;
    yield { properties: feature.properties ?? {}, geometry: feature.geometry };
  }
}
