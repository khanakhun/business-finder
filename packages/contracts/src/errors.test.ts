import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BudgetExceededError,
  ConflictError,
  DomainError,
  ERROR_CODES,
  ExternalServiceError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  ProblemDetailsSchema,
  RateLimitedError,
  ValidationError,
} from './errors.ts';

describe('error code registry', () => {
  it('uses stable SCREAMING_SNAKE codes with 4xx/5xx statuses', () => {
    for (const [code, { status, title }] of Object.entries(ERROR_CODES)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
      expect(title.length).toBeGreaterThan(0);
    }
  });
});

describe('DomainError subclasses', () => {
  const cases: Array<[DomainError, string, number]> = [
    [new NotFoundError('Business', 'b1'), 'NOT_FOUND', 404],
    [new ValidationError('bad'), 'VALIDATION_FAILED', 422],
    [new ConflictError('dup'), 'CONFLICT', 409],
    [new ForbiddenError('no'), 'FORBIDDEN', 403],
    [new InvalidStateTransitionError('Site', 'draft', 'expired'), 'INVALID_STATE_TRANSITION', 409],
    [new RateLimitedError('slow down', 30), 'RATE_LIMITED', 429],
    [new ExternalServiceError('Google Places', 'timeout'), 'EXTERNAL_SERVICE_FAILED', 502],
    [new BudgetExceededError('over budget'), 'BUDGET_EXCEEDED', 402],
  ];

  it.each(cases)('%s has code and status', (error, code, status) => {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(status);
    expect(error.name).toBe(error.constructor.name);
  });

  it('carries details and cause', () => {
    const cause = new Error('socket hang up');
    const error = new ExternalServiceError('PSI', 'failed', { cause, details: { url: 'x' } });
    expect(error.cause).toBe(cause);
    expect(error.details).toEqual({ service: 'PSI', url: 'x' });
    expect(new InvalidStateTransitionError('Site', 'a', 'b').details).toEqual({
      entity: 'Site',
      from: 'a',
      to: 'b',
    });
    expect(new RateLimitedError('x', 12).retryAfterSeconds).toBe(12);
    expect(new ConflictError('x').details).toBeUndefined();
  });
});

describe('toProblem', () => {
  it('produces a valid RFC 9457 problem', () => {
    const problem = new NotFoundError('Business', '0192f').toProblem('/v1/businesses/0192f', 'trace-1');
    expect(ProblemDetailsSchema.parse(problem)).toEqual({
      type: 'https://errors.business-finder.dev/NOT_FOUND',
      title: 'Not found',
      status: 404,
      detail: 'Business 0192f not found.',
      instance: '/v1/businesses/0192f',
      code: 'NOT_FOUND',
      traceId: 'trace-1',
    });
  });

  it('never leaks internal messages for 5xx', () => {
    const problem = new ExternalServiceError('db', 'password authentication failed for user x').toProblem();
    expect(problem.detail).toBe('External service failed');
    expect(problem).not.toHaveProperty('instance');
  });

  it('includes field errors for validation failures, converted from Zod', () => {
    const result = z.object({ rating: z.number().max(5) }).safeParse({ rating: 9 });
    if (result.success) throw new Error('expected failure');
    const problem = ValidationError.fromZod(result.error).toProblem();
    expect(problem.status).toBe(422);
    expect(problem.errors).toEqual([{ path: ['rating'], message: expect.stringContaining('5') }]);
    expect(ProblemDetailsSchema.safeParse(problem).success).toBe(true);
  });

  it('stringifies symbol path segments', () => {
    const error = ValidationError.fromZod(
      new z.ZodError([{ code: 'custom', path: [Symbol.for('s'), 0], message: 'm', input: undefined }]),
    );
    expect(error.errors).toEqual([{ path: ['Symbol(s)', 0], message: 'm' }]);
  });
});
