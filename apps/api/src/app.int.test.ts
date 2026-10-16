import { NotFoundError } from '@bf/contracts';
import { Controller, Get } from '@nestjs/common';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp, type TestApp } from '../test/create-test-app.ts';
import { AllowAnonymous } from './modules/platform/security/auth.decorators.ts';
import { ApiRoute } from './modules/platform/validation/api-route.decorator.ts';

@Controller('test-platform')
@AllowAnonymous()
class PlatformProbeController {
  @Get('domain-error')
  domainError(): never {
    throw new NotFoundError('Widget', 'w1');
  }

  @Get('crash')
  crash(): never {
    throw new Error('connection string postgres://user:hunter2@db');
  }

  @Get('drift')
  @ApiRoute({
    summary: 'returns a body violating its schema',
    response: { status: 200, schema: z.object({ ok: z.literal(true) }) },
  })
  drift() {
    return { ok: 'yes' };
  }
}

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ controllers: [PlatformProbeController], valkeyDb: 1 });
  await new Redis(t.env.VALKEY_URL).flushdb().then(() => undefined);
});
afterAll(() => t.close());

describe('GET /v1/system/info', () => {
  it('returns build info with the injected clock and a request id', async () => {
    const res = await t.http.get('/v1/system/info').expect(200);
    expect(res.body).toEqual({
      name: 'business-finder-api',
      version: '0.0.0-dev',
      commit: null,
      env: 'test',
      time: '2026-10-14T12:00:00.000Z',
    });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a safe caller request id', async () => {
    const res = await t.http.get('/v1/system/info').set('x-request-id', 'trace-me-123').expect(200);
    expect(res.headers['x-request-id']).toBe('trace-me-123');
  });

  it('sets security headers', async () => {
    const res = await t.http.get('/v1/system/info');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('problem+json', () => {
  it('for unknown routes', async () => {
    const res = await t.http.get('/v1/does-not-exist').expect(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', status: 404, instance: '/v1/does-not-exist' });
  });

  it('for malformed JSON bodies', async () => {
    const res = await t.http
      .post('/v1/system/info')
      .set('content-type', 'application/json')
      .send('{"broken": ')
      .expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  });

  it('for domain errors', async () => {
    const res = await t.http.get('/v1/test-platform/domain-error').expect(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', detail: 'Widget w1 not found.' });
  });

  it('for unknown errors, without internals', async () => {
    const res = await t.http.get('/v1/test-platform/crash').expect(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL', detail: 'Internal error' });
    expect(res.text).not.toContain('hunter2');
  });

  it('when a response drifts from its schema (dev/test only)', async () => {
    const res = await t.http.get('/v1/test-platform/drift').expect(500);
    expect(res.body.code).toBe('INTERNAL');
  });
});

describe('health and metrics', () => {
  it('reports live and ready with real dependencies', async () => {
    await t.http.get('/health/live').expect(200);
    const ready = await t.http.get('/health/ready').expect(200);
    expect(ready.body.details).toMatchObject({ database: { status: 'up' }, valkey: { status: 'up' } });
  });

  it('exposes Prometheus metrics with RED labels by route template', async () => {
    await t.http.get('/v1/system/info');
    const res = await t.http.get('/metrics').expect(200);
    expect(res.text).toMatch(
      /bf_http_requests_total\{method="GET",route="\/v1\/system\/info",status="2xx"\} \d+/,
    );
    expect(res.text).toContain('process_cpu_user_seconds_total');
  });
});

describe('readiness with a dependency down', () => {
  it('returns 503 when Valkey is unreachable', async () => {
    const broken = await createTestApp({ env: { VALKEY_URL: 'redis://127.0.0.1:1' } });
    try {
      const res = await broken.http.get('/health/ready').expect(503);
      expect(res.body.details).toMatchObject({ database: { status: 'up' }, valkey: { status: 'down' } });
    } finally {
      await broken.close();
    }
  });
});

describe('rate limiting', () => {
  it('answers 429 problem+json after 60 anonymous requests per minute', async () => {
    const limited = await createTestApp({ valkeyDb: 2 });
    try {
      await new Redis(limited.env.VALKEY_URL).flushdb();
      for (let i = 0; i < 60; i++) await limited.http.get('/v1/system/info').expect(200);
      const res = await limited.http.get('/v1/system/info').expect(429);
      expect(res.body).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
      // Health and metrics are never throttled (probes and scrapers).
      await limited.http.get('/health/live').expect(200);
    } finally {
      await limited.close();
    }
  });
});

describe('Valkey outage on the request path', () => {
  it('fails open: requests are served (not rate limited) and do not hang', async () => {
    const outage = await createTestApp({ env: { VALKEY_URL: 'redis://127.0.0.1:1' } });
    try {
      // Several requests: the first fails fast on "connection refused", later ones used to wait in ioredis's
      // offline queue while it reconnected (~10 s each).
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        await outage.http.get('/v1/system/info').expect(200);
        expect(performance.now() - started).toBeLessThan(1_000);
      }
    } finally {
      await outage.close();
    }
  });
});
