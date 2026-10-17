import { readFileSync } from 'node:fs';
import type { AnalyticsRegistry, DimensionDefinition, MetricDefinition } from '@bf/contracts';
import { METRIC_FORMATS } from '@bf/contracts';
import { parse } from 'yaml';
import { z } from 'zod';

// The semantic registry (BF-058): metrics and dimensions read once from the YAML next to this file and checked. Their
// SQL is ours (never built from a request); a query names them and the compiler looks them up here.

const Localized = z.strictObject({ en: z.string().min(1), fr: z.string().min(1) });
const Id = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);

const MetricSchema = z
  .object({
    id: Id,
    format: z.enum(METRIC_FORMATS),
    sql: z.string().min(1).optional(),
    numerator: Id.optional(),
    denominator: Id.optional(),
    label: Localized,
    description: Localized,
    caveats: Localized.optional(),
  })
  .refine((m) => (m.sql ? !m.numerator && !m.denominator : Boolean(m.numerator && m.denominator)), {
    message: 'A metric has either `sql` or both `numerator` and `denominator`',
  });

const DimensionSchema = z.object({
  id: Id,
  time: z.boolean().default(false),
  sql: z.string().min(1),
  label: Localized,
  description: Localized,
});

export type MetricSpec = z.infer<typeof MetricSchema>;
export type DimensionSpec = z.infer<typeof DimensionSchema>;

export interface SemanticRegistry {
  readonly metrics: ReadonlyMap<string, MetricSpec>;
  readonly dimensions: ReadonlyMap<string, DimensionSpec>;
}

const load = <T extends { id: string }>(file: string, schema: z.ZodType<T>): Map<string, T> => {
  const raw: unknown = parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
  const items = z.array(schema).parse(raw);
  const byId = new Map<string, T>();
  for (const item of items) {
    if (byId.has(item.id)) throw new Error(`Duplicate analytics definition: ${item.id}`);
    byId.set(item.id, item);
  }
  return byId;
};

/** Checks the rates name existing base metrics (a rate of rates is not allowed). */
function check(registry: SemanticRegistry): SemanticRegistry {
  for (const metric of registry.metrics.values())
    for (const part of [metric.numerator, metric.denominator]) {
      if (part === undefined) continue;
      const base = registry.metrics.get(part);
      if (!base?.sql) throw new Error(`Metric ${metric.id}: ${part} is not a base metric`);
    }
  return registry;
}

let cached: SemanticRegistry | null = null;

export function semanticRegistry(): SemanticRegistry {
  cached ??= check({
    metrics: load('./metrics.yaml', MetricSchema as z.ZodType<MetricSpec>),
    dimensions: load('./dimensions.yaml', DimensionSchema as z.ZodType<DimensionSpec>),
  });
  return cached;
}

/** The registry as the API shows it ("How is this calculated?"). */
export function publicRegistry(registry: SemanticRegistry): AnalyticsRegistry {
  const metrics: MetricDefinition[] = [...registry.metrics.values()].map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
    format: m.format,
    numerator: m.numerator ?? null,
    denominator: m.denominator ?? null,
    caveats: m.caveats ?? null,
  }));
  const dimensions: DimensionDefinition[] = [...registry.dimensions.values()].map((d) => ({
    id: d.id,
    label: d.label,
    description: d.description,
    time: d.time,
  }));
  return { metrics, dimensions };
}
