import { describe, expect, it } from 'vitest';
import { metrics, metricsHandler } from './metrics.ts';

describe('metrics', () => {
  it('exposes counters, histograms and gauges in Prometheus text with default process metrics', async () => {
    const jobs = metrics.counter({
      name: 'bf_jobs_processed_total',
      help: 'Jobs processed',
      labelNames: ['queue', 'outcome'],
    });
    jobs.inc({ queue: 'enrichment', outcome: 'ok' });
    jobs.inc({ queue: 'enrichment', outcome: 'ok' });
    metrics
      .histogram({ name: 'bf_http_request_duration_seconds', help: 'HTTP latency', labelNames: ['route'] })
      .observe({ route: '/v1/x' }, 0.03);
    metrics.gauge({ name: 'bf_queue_depth_jobs', help: 'Waiting jobs' }).set(7);

    const { contentType, body } = await metricsHandler();
    expect(contentType).toMatch(/^text\/plain/);
    expect(body).toContain('bf_jobs_processed_total{queue="enrichment",outcome="ok"} 2');
    expect(body).toContain('bf_http_request_duration_seconds_bucket{le="0.05",route="/v1/x"} 1');
    expect(body).toContain('bf_queue_depth_jobs 7');
    expect(body).toContain('process_cpu_user_seconds_total');
    expect(body).toContain('nodejs_eventloop_lag_seconds');
  });

  it('returns the existing metric when registered twice', () => {
    const a = metrics.counter({ name: 'bf_test_twice_total', help: 'x' });
    expect(metrics.counter({ name: 'bf_test_twice_total', help: 'x' })).toBe(a);
  });

  it.each([
    ['jobs_total', 'counter'],
    ['bf_jobs', 'counter'],
    ['bf_Jobs_total', 'counter'],
    ['bf_x', 'gauge'],
  ] as const)('rejects badly named %s (%s)', (name, kind) => {
    expect(() => metrics[kind]({ name, help: 'x' })).toThrow();
  });
});
