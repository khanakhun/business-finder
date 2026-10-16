import { ConflictError, DomainError, NotFoundError, RateLimitedError, ValidationError } from '@bf/contracts';
import {
  BadRequestException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { BrokenCircuitError } from 'cockatiel';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadAppEnv } from './config/app-env.ts';
import { resolveRequestId } from './context/request-context.ts';
import { toProblem } from './errors/problem-details.filter.ts';
import { buildPolicy, isTransient, WithResilience } from './resilience/resilience.ts';
import { zodDto } from './validation/zod-dto.ts';
import { ZodValidationPipe } from './validation/zod-validation.pipe.ts';

describe('toProblem', () => {
  it('maps DomainErrors to their status and code', () => {
    expect(toProblem(new NotFoundError('Business', 'b1'), '/v1/b/b1', 'trace')).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      instance: '/v1/b/b1',
      traceId: 'trace',
      detail: 'Business b1 not found.',
    });
    expect(toProblem(new ConflictError('dup'), '/x', undefined)).toMatchObject({
      status: 409,
      code: 'CONFLICT',
    });
  });

  it('maps Zod errors to 422 with field errors', () => {
    const result = z.object({ count: z.number() }).safeParse({ count: 'x' });
    const problem = toProblem(result.error, '/x', undefined);
    expect(problem).toMatchObject({ status: 422, code: 'VALIDATION_FAILED', errors: [{ path: ['count'] }] });
    expect(problem).not.toHaveProperty('traceId');
  });

  it.each([
    [new NotFoundException(), 404, 'NOT_FOUND'],
    [new BadRequestException('Unexpected token'), 400, 'VALIDATION_FAILED'],
    [new PayloadTooLargeException(), 413, 'VALIDATION_FAILED'],
    [new ThrottlerException(), 429, 'RATE_LIMITED'],
    [new HttpException('nope', 401), 401, 'UNAUTHENTICATED'],
    [new HttpException('nope', 403), 403, 'FORBIDDEN'],
    [new HttpException('nope', 409), 409, 'CONFLICT'],
  ] as const)('maps Nest %s', (error, status, code) => {
    expect(toProblem(error, '/x', undefined)).toMatchObject({ status, code });
  });

  it('maps exposable 4xx errors from Express middleware (body parsers)', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), { status: 413, expose: true });
    expect(toProblem(tooLarge, '/x', undefined)).toMatchObject({ status: 413, code: 'VALIDATION_FAILED' });
    const hidden = Object.assign(new Error('internal detail'), { status: 413, expose: false });
    expect(toProblem(hidden, '/x', undefined)).toMatchObject({ status: 500, code: 'INTERNAL' });
  });

  it('never leaks internals of unknown errors or Nest 5xx', () => {
    const unknown = toProblem(new Error('password=hunter2 at db.ts:12'), '/x', undefined);
    expect(unknown).toMatchObject({ status: 500, code: 'INTERNAL', detail: 'Internal error' });
    expect(JSON.stringify(unknown)).not.toContain('hunter2');
    const nest5xx = toProblem(new HttpException('stack secret', 503), '/x', undefined);
    expect(nest5xx).toMatchObject({ status: 503, code: 'INTERNAL' });
    expect(nest5xx).not.toHaveProperty('detail');
  });
});

describe('ZodValidationPipe', () => {
  const Body = zodDto(z.object({ count: z.number().int().default(1) }));
  const pipe = new ZodValidationPipe();

  it('parses and applies defaults for zodDto parameters', () => {
    expect(pipe.transform({}, { type: 'body', metatype: Body })).toEqual({ count: 1 });
  });

  it('rejects invalid input with a ValidationError', () => {
    expect(() => pipe.transform({ count: 1.5 }, { type: 'body', metatype: Body })).toThrow(ValidationError);
  });

  it('leaves other parameters untouched', () => {
    expect(pipe.transform('raw', { type: 'param', metatype: String })).toBe('raw');
    expect(pipe.transform('raw', { type: 'custom' })).toBe('raw');
  });
});

describe('resolveRequestId', () => {
  it('keeps safe caller ids and replaces unsafe or missing ones', () => {
    expect(resolveRequestId('abc-123:x.y')).toBe('abc-123:x.y');
    expect(resolveRequestId(['first', 'second'])).toBe('first');
    for (const bad of [undefined, '', 'has space', 'x'.repeat(129), 'inject\nheader']) {
      expect(resolveRequestId(bad)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('resilience', () => {
  const fast = {
    timeoutMs: 50,
    maxRetries: 2,
    initialDelayMs: 1,
    maxDelayMs: 2,
    breakerThreshold: 3,
    halfOpenAfterMs: 60_000,
  };

  it('retries transient failures, then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue('ok');
    expect(await buildPolicy(fast).execute(fn)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    await expect(buildPolicy(fast).execute(fn)).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('neither retries nor counts a cancellation (aborted fetch, cancelled job)', async () => {
    const policy = buildPolicy({ ...fast, breakerThreshold: 2 });
    for (const name of ['AbortError', 'JobCancelledError', 'AbortError']) {
      // The caller's signal aborts the request itself (as adapters do), with this reason.
      const controller = new AbortController();
      const cancelled = Object.assign(new Error('cancelled'), { name });
      const fn = vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_, reject) => {
            const both = AbortSignal.any([signal, controller.signal]);
            both.addEventListener('abort', () => reject(cancelled), { once: true });
            controller.abort(cancelled);
          }),
      );
      await expect(policy.execute(fn)).rejects.toBe(cancelled);
      expect(fn).toHaveBeenCalledTimes(1);
    }
    // Three cancellations, threshold two: the breaker is still closed.
    expect(await policy.execute(async () => 'ok')).toBe('ok');
  });

  it('does not retry client-side domain errors', async () => {
    const fn = vi.fn().mockRejectedValue(new ValidationError('bad'));
    await expect(buildPolicy(fast).execute(fn)).rejects.toThrow(ValidationError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isTransient(new RateLimitedError('slow'))).toBe(false);
    expect(
      isTransient(
        new (class extends DomainError {
          readonly code = 'INTERNAL';
        })('x'),
      ),
    ).toBe(true);
  });

  it('opens the circuit after consecutive failures', async () => {
    const policy = buildPolicy({ ...fast, maxRetries: 0 });
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    for (let i = 0; i < 3; i++) await expect(policy.execute(fn)).rejects.toThrow('down');
    await expect(policy.execute(fn)).rejects.toBeInstanceOf(BrokenCircuitError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('times out slow attempts', async () => {
    const slow = () => new Promise((resolve) => setTimeout(resolve, 500));
    await expect(buildPolicy({ ...fast, maxRetries: 0 }).execute(slow)).rejects.toThrow(/timed out|cancel/i);
  });

  it('decorates methods with a named policy', async () => {
    class Adapter {
      calls = 0;
      @WithResilience('default')
      async fetch(): Promise<string> {
        this.calls++;
        if (this.calls === 1) throw new Error('blip');
        return `ok after ${this.calls}`;
      }
    }
    const adapter = new Adapter();
    expect(await adapter.fetch()).toBe('ok after 2');
  });
});

describe('loadAppEnv', () => {
  const env = {
    DATABASE_URL: 'postgres://u:p@h:5432/d',
    VALKEY_URL: 'redis://h:6379',
    S3_ENDPOINT: 'http://h:9000',
    S3_ACCESS_KEY_ID: 'a',
    S3_SECRET_ACCESS_KEY: 'b',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    SECRETS_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
    SMTP_URL: 'smtp://h:25',
    INTEL_SHARED_SECRET: 'y'.repeat(32),
  };

  it('loads a valid environment', () => {
    expect(loadAppEnv('http', env).API_PORT).toBe(4000);
  });

  it('boots in production now that authentication exists (BF-010 removed the guard)', () => {
    expect(loadAppEnv('http', { ...env, NODE_ENV: 'production' }).NODE_ENV).toBe('production');
  });

  it('needs no environment in openapi mode', () => {
    expect(loadAppEnv('openapi').NODE_ENV).toBe('development');
  });
});
