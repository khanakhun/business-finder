import { NotFoundError, RateLimitedError } from '@bf/contracts';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AppEnv } from './config/app-env.ts';
import { getRequestContext, RequestContextMiddleware } from './context/request-context.ts';
import { PROBLEM_CONTENT_TYPE, ProblemDetailsFilter } from './errors/problem-details.filter.ts';
import type { Logger } from './logging/logger.ts';
import { ApiRoute, RESPONSE_SCHEMA } from './validation/api-route.decorator.ts';
import {
  ResponseContractError,
  ResponseValidationInterceptor,
} from './validation/response-validation.interceptor.ts';
import { zodDto } from './validation/zod-dto.ts';

function fakeResponse() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    contentType: '',
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    type(t: string) {
      res.contentType = t;
      return res;
    },
    send(b: string) {
      res.body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
  };
  return res;
}

function httpHost(res: ReturnType<typeof fakeResponse>) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ originalUrl: '/v1/x' }), getResponse: () => res }),
  } as never;
}

// @nestjs/swagger's metadata keys (its constants module is not exported).
const DECORATORS = {
  API_RESPONSE: 'swagger/apiResponse',
  API_PARAMETERS: 'swagger/apiParameters',
  API_OPERATION: 'swagger/apiOperation',
} as const;

const fakeLogger = () =>
  ({ error: vi.fn(), warn: vi.fn() }) as unknown as Logger & {
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };

describe('ProblemDetailsFilter', () => {
  it('writes problem+json and logs 4xx as warnings', () => {
    const logger = fakeLogger();
    const res = fakeResponse();
    new ProblemDetailsFilter(logger).catch(new NotFoundError('Widget', 'w1'), httpHost(res));
    expect(res.statusCode).toBe(404);
    expect(res.contentType).toBe(PROBLEM_CONTENT_TYPE);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'NOT_FOUND', instance: '/v1/x' });
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs 5xx as errors with the original error', () => {
    const logger = fakeLogger();
    const boom = new Error('boom');
    new ProblemDetailsFilter(logger).catch(boom, httpHost(fakeResponse()));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, code: 'INTERNAL' }),
      'request failed',
    );
  });

  it('sets Retry-After for rate-limited domain errors', () => {
    const res = fakeResponse();
    new ProblemDetailsFilter(fakeLogger()).catch(new RateLimitedError('slow down', 30), httpHost(res));
    expect(res.headers['Retry-After']).toBe('30');
  });
});

describe('ResponseValidationInterceptor', () => {
  const schema = z.object({ ok: z.literal(true) });
  class Controller {
    @ApiRoute({ summary: 'x', response: { status: 200, schema } })
    handler() {
      return { ok: true };
    }
    undocumented() {
      return 1;
    }
  }
  const context = (method: keyof Controller) =>
    ({
      getHandler: () => Controller.prototype[method],
      getClass: () => Controller,
    }) as unknown as ExecutionContext;
  const env = (NODE_ENV: AppEnv['NODE_ENV']) => ({ NODE_ENV }) as AppEnv;

  it('passes valid bodies through', async () => {
    const interceptor = new ResponseValidationInterceptor(new Reflector(), env('test'));
    expect(
      await lastValueFrom(interceptor.intercept(context('handler'), { handle: () => of({ ok: true }) })),
    ).toEqual({ ok: true });
  });

  it('rejects bodies that drift from the schema', async () => {
    const interceptor = new ResponseValidationInterceptor(new Reflector(), env('development'));
    await expect(
      lastValueFrom(interceptor.intercept(context('handler'), { handle: () => of({ ok: 'yes' }) })),
    ).rejects.toThrow(ResponseContractError);
  });

  it('skips undocumented routes and production', async () => {
    const reflector = new Reflector();
    expect(
      await lastValueFrom(
        new ResponseValidationInterceptor(reflector, env('test')).intercept(context('undocumented'), {
          handle: () => of(1),
        }),
      ),
    ).toBe(1);
    expect(
      await lastValueFrom(
        new ResponseValidationInterceptor(reflector, env('production')).intercept(context('handler'), {
          handle: () => of({ ok: 'no' }),
        }),
      ),
    ).toEqual({ ok: 'no' });
  });
});

describe('ApiRoute', () => {
  const Named = z.object({ id: z.string() }).meta({ id: 'TestNamedThing' });
  const Query = zodDto(z.object({ limit: z.number().optional(), q: z.string() }));
  class Controller {
    @ApiRoute({
      summary: 'Create',
      operationId: 'createThing',
      body: Named,
      query: Query,
      response: { status: 201, schema: Named },
      errors: [404],
    })
    create() {}

    @ApiRoute({ summary: 'Delete', response: { status: 204, schema: null } })
    remove() {}
  }

  it('documents body, query, success and problem responses', () => {
    const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, Controller.prototype.create);
    expect(Object.keys(responses).sort()).toEqual(['201', '404', '422', '500']);
    expect(responses['201'].schema).toEqual({ $ref: '#/components/schemas/TestNamedThing' });
    expect(responses['404'].content[PROBLEM_CONTENT_TYPE].schema).toEqual({
      $ref: '#/components/schemas/ProblemDetails',
    });
    const params = Reflect.getMetadata(DECORATORS.API_PARAMETERS, Controller.prototype.create);
    expect(
      params.map((p: { name: string; in: string; required: boolean }) => [p.name, p.in, p.required]),
    ).toEqual(
      expect.arrayContaining([
        ['q', 'query', true],
        ['limit', 'query', false],
      ]),
    );
    expect(Reflect.getMetadata(DECORATORS.API_OPERATION, Controller.prototype.create)).toMatchObject({
      operationId: 'createThing',
    });
    expect(Reflect.getMetadata(RESPONSE_SCHEMA, Controller.prototype.create)).toEqual({
      status: 201,
      schema: Named,
    });
  });

  it('documents body-less responses without a schema', () => {
    const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, Controller.prototype.remove);
    expect(responses['204']).not.toHaveProperty('schema');
    expect(Object.keys(responses).sort()).toEqual(['204', '500']);
  });
});

describe('RequestContextMiddleware', () => {
  it('sets the request id header and makes the context available downstream', () => {
    const res = fakeResponse();
    let seen: string | undefined;
    new RequestContextMiddleware({} as never).use(
      { headers: { 'x-request-id': 'abc' }, socket: {} } as never,
      res as never,
      () => {
        seen = getRequestContext()?.requestId;
      },
    );
    expect(res.headers['x-request-id']).toBe('abc');
    expect(seen).toBe('abc');
    expect(getRequestContext()).toBeUndefined();
  });

  it('records the client address behind trusted proxies and the user agent', () => {
    let seen: { ip?: string; userAgent?: string } | undefined;
    const req = {
      headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Vitest' },
      socket: { remoteAddress: '::ffff:10.0.0.2' },
    };
    new RequestContextMiddleware({ AUTH_TRUSTED_PROXIES: ['10.0.0.0/8'] } as never).use(
      req as never,
      fakeResponse() as never,
      () => {
        seen = getRequestContext();
      },
    );
    expect(seen).toMatchObject({ ip: '203.0.113.7', userAgent: 'Vitest' });
  });
});
