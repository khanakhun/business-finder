import { describe, expect, it } from 'vitest';
import { aggregateHealth, type HealthIndicator } from './health.ts';

const up = (name: string, critical = true): HealthIndicator => ({
  name,
  critical,
  check: async () => ({ status: 'up', details: { ok: true } }),
});
const down = (name: string, critical = true): HealthIndicator => ({
  name,
  critical,
  check: async () => ({ status: 'down' }),
});
const throwing = (name: string): HealthIndicator => ({
  name,
  check: () => Promise.reject(new Error('connection refused')),
});

describe('aggregateHealth', () => {
  it('is up when every check is up', async () => {
    const report = await aggregateHealth([up('db'), up('valkey')]);
    expect(report.status).toBe('up');
    expect(report.checks.db).toMatchObject({ status: 'up', critical: true, details: { ok: true } });
  });

  it('is degraded when only non-critical checks fail', async () => {
    expect((await aggregateHealth([up('db'), down('intel', false)])).status).toBe('degraded');
  });

  it('is down when a critical check fails or throws, reporting the error', async () => {
    const report = await aggregateHealth([up('valkey'), throwing('db')]);
    expect(report.status).toBe('down');
    expect(report.checks.db).toMatchObject({ status: 'down', error: 'connection refused' });
    expect((await aggregateHealth([down('s3')])).status).toBe('down');
  });

  it('times out slow checks and aborts them', async () => {
    let aborted = false;
    const slow: HealthIndicator = {
      name: 'slow',
      check: (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ status: 'up' });
          });
        }),
    };
    const report = await aggregateHealth([slow], { timeoutMs: 20 });
    expect(report.checks.slow).toMatchObject({ status: 'down', error: 'timed out after 20 ms' });
    expect(aborted).toBe(true);
  });

  it('reports non-Error rejections', async () => {
    const odd: HealthIndicator = { name: 'odd', check: () => Promise.reject('nope') };
    expect((await aggregateHealth([odd])).checks.odd?.error).toBe('nope');
  });

  it('is up with no indicators', async () => {
    expect(await aggregateHealth([])).toEqual({ status: 'up', checks: {} });
  });
});
