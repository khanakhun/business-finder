import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from '@prometheus-io/client';

/** One registry per process; `/metrics` serves it. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

/** Seconds; covers fast cache hits to slow provider calls (HTTP, jobs, external APIs). */
export const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

// docs/OBSERVABILITY.md: bf_<area>_<name>_<unit>; counters end in _total.
const METRIC_NAME = /^bf_[a-z0-9]+(_[a-z0-9]+)+$/;

interface MetricOptions<L extends string> {
  readonly name: string;
  readonly help: string;
  readonly labelNames?: readonly L[];
}

function checkName(name: string, kind: 'counter' | 'histogram' | 'gauge'): void {
  if (!METRIC_NAME.test(name)) throw new Error(`Metric "${name}" must match bf_<area>_<name>_<unit>`);
  if (kind === 'counter' && !name.endsWith('_total'))
    throw new Error(`Counter "${name}" must end with _total`);
}

/** Returns the already-registered metric of that name (module reloads, several callers) or registers it. */
function getOrCreate<M>(name: string, create: () => M): M {
  return (registry.getSingleMetric(name) as M | undefined) ?? create();
}

export const metrics = {
  counter<L extends string = never>(options: MetricOptions<L>): Counter<L> {
    checkName(options.name, 'counter');
    return getOrCreate(
      options.name,
      () =>
        new Counter({
          ...options,
          labelNames: [...(options.labelNames ?? [])],
          registers: [registry],
        }),
    );
  },
  histogram<L extends string = never>(
    options: MetricOptions<L> & { readonly buckets?: readonly number[] },
  ): Histogram<L> {
    checkName(options.name, 'histogram');
    return getOrCreate(
      options.name,
      () =>
        new Histogram({
          ...options,
          labelNames: [...(options.labelNames ?? [])],
          buckets: [...(options.buckets ?? LATENCY_BUCKETS_SECONDS)],
          registers: [registry],
        }),
    );
  },
  gauge<L extends string = never>(options: MetricOptions<L>): Gauge<L> {
    checkName(options.name, 'gauge');
    return getOrCreate(
      options.name,
      () => new Gauge({ ...options, labelNames: [...(options.labelNames ?? [])], registers: [registry] }),
    );
  },
};

/** Prometheus text exposition for a `/metrics` route. */
export async function metricsHandler(): Promise<{ contentType: string; body: string }> {
  return { contentType: registry.contentType, body: await registry.metrics() };
}
