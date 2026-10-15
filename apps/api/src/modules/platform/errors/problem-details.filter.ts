import {
  DomainError,
  ERROR_CODES,
  ERROR_TYPE_BASE,
  type ErrorCode,
  type ProblemDetails,
  RateLimitedError,
  ValidationError,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { LOGGER } from '../logging/logger.ts';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Nest/HTTP-layer exceptions (unknown route, bad JSON, throttling, …) mapped onto registry codes. */
function codeForHttpStatus(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 400 && status < 500) return 'VALIDATION_FAILED';
  return 'INTERNAL';
}

/**
 * The one place errors become HTTP responses (api.md §4): DomainError → its status and code; Zod errors → 422
 * with field errors; Nest HttpExceptions → mapped codes; anything else → 500 without internals.
 */
export function toProblem(error: unknown, instance: string, traceId: string | undefined): ProblemDetails {
  if (error instanceof DomainError) return error.toProblem(instance, traceId);
  if (error instanceof ZodError) return ValidationError.fromZod(error).toProblem(instance, traceId);
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = codeForHttpStatus(status);
    return {
      type: `${ERROR_TYPE_BASE}${code}`,
      title: ERROR_CODES[code].title,
      status,
      // Nest messages for 4xx are generic and safe ("Cannot GET /x", "Unexpected token…"); never for 5xx.
      ...(status < 500 ? { detail: error.message } : {}),
      code,
      instance,
      ...(traceId ? { traceId } : {}),
    };
  }
  if (isClientHttpError(error)) {
    const code = codeForHttpStatus(error.status);
    return {
      type: `${ERROR_TYPE_BASE}${code}`,
      title: ERROR_CODES[code].title,
      status: error.status,
      // Body-parser messages are generic ("request entity too large"); never echo the body.
      detail: error.message,
      code,
      instance,
      ...(traceId ? { traceId } : {}),
    };
  }
  return new InternalError().toProblem(instance, traceId);
}

/** `http-errors` thrown by Express middleware (body parsers): 4xx, flagged safe to expose. */
function isClientHttpError(error: unknown): error is { status: number; message: string } {
  if (typeof error !== 'object' || error === null) return false;
  const { status, expose, message } = error as { status?: unknown; expose?: unknown; message?: unknown };
  return (
    expose === true &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    typeof message === 'string'
  );
}

class InternalError extends DomainError {
  readonly code = 'INTERNAL';
  constructor() {
    super('Internal error');
  }
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const span = trace.getActiveSpan()?.spanContext();
    const traceId = span && isSpanContextValid(span) ? span.traceId : undefined;
    const problem = toProblem(error, req.originalUrl, traceId);

    if (problem.status >= 500) this.logger.error({ err: error, code: problem.code }, 'request failed');
    else this.logger.warn({ code: problem.code, status: problem.status }, problem.detail ?? problem.title);

    if (error instanceof RateLimitedError && error.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
    }
    res.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(problem));
  }
}
