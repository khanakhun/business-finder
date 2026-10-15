import { z } from 'zod';
import { ProblemDetailsSchema } from './errors.ts';
import { LatLngSchema } from './geo.ts';
import { EchoRequestSchema, EchoResponseSchema } from './intel.ts';
import {
  OpenDataPlaceSchema,
  OpenDataSearchRequestSchema,
  OpenDataSearchResponseSchema,
} from './open-data.ts';

/** Languages schemas can be exported to. `python` → services/intel Pydantic models (BF-008). */
export const EXPORT_TARGETS = ['python'] as const;
export type ExportTarget = (typeof EXPORT_TARGETS)[number];

export interface ExportMeta {
  /** Stable PascalCase name; becomes the file name, `$id` and `title`. */
  readonly id: string;
  readonly exportTo: readonly ExportTarget[];
  readonly description?: string;
}

const entries: Array<{ readonly schema: z.ZodType; readonly meta: ExportMeta }> = [];

/** Opts a schema in to JSON Schema export. Ids are unique across all targets. */
export function exportSchema<T extends z.ZodType>(schema: T, meta: ExportMeta): T {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(meta.id)) throw new Error(`Export id "${meta.id}" must be PascalCase`);
  if (entries.some((e) => e.meta.id === meta.id)) throw new Error(`Export id "${meta.id}" is already used`);
  entries.push({ schema, meta });
  return schema;
}

// Shared shapes services/intel reads or returns.
exportSchema(ProblemDetailsSchema, {
  id: 'ProblemDetails',
  exportTo: ['python'],
  description: 'RFC 9457 problem details (application/problem+json).',
});
exportSchema(LatLngSchema, {
  id: 'LatLng',
  exportTo: ['python'],
  description: 'WGS84 coordinates in decimal degrees.',
});

exportSchema(EchoRequestSchema, {
  id: 'EchoRequest',
  exportTo: ['python'],
  description: 'POST /v1/echo request on services/intel.',
});
exportSchema(EchoResponseSchema, {
  id: 'EchoResponse',
  exportTo: ['python'],
  description: 'POST /v1/echo response on services/intel.',
});

exportSchema(OpenDataSearchRequestSchema, {
  id: 'OpenDataSearchRequest',
  exportTo: ['python'],
  description: 'POST /v1/open-data/places/search request on services/intel.',
});
exportSchema(OpenDataPlaceSchema, {
  id: 'OpenDataPlace',
  exportTo: ['python'],
  description: 'A place from an open dataset, as services/intel normalizes it.',
});
exportSchema(OpenDataSearchResponseSchema, {
  id: 'OpenDataSearchResponse',
  exportTo: ['python'],
  description: 'POST /v1/open-data/places/search response on services/intel.',
});

export const JSON_SCHEMA_BASE = 'https://schemas.business-finder.dev/';

/** Deterministic JSON Schema documents (draft 2020-12) for one target, keyed by id in sorted order. */
export function buildJsonSchemas(target: ExportTarget): Record<string, unknown> {
  const selected = entries.filter((e) => e.meta.exportTo.includes(target));
  // A fresh registry per target: cross-references between exported schemas become `$ref`s to their files.
  const registry = z.registry<{ id: string }>();
  for (const { schema, meta } of selected) registry.add(schema, { id: meta.id });
  const { schemas } = z.toJSONSchema(registry, {
    target: 'draft-2020-12',
    uri: (id) => `${JSON_SCHEMA_BASE}${id}.json`,
  });
  const out: Record<string, unknown> = {};
  for (const { meta } of [...selected].sort((a, b) => a.meta.id.localeCompare(b.meta.id))) {
    out[meta.id] = sortKeys({
      ...schemas[meta.id],
      $id: `${JSON_SCHEMA_BASE}${meta.id}.json`,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: meta.id,
      ...(meta.description ? { description: meta.description } : {}),
    });
  }
  return out;
}

/** Recursively sorts object keys so output is byte-identical across runs. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortKeys(v)]),
  );
}
