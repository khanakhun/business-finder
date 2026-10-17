import { z } from 'zod';

/**
 * The single list of error codes (api.md §4). Codes are stable: clients and logs key on them.
 * Name them `<CONTEXT>_<REASON>`; generic ones cover cross-cutting cases. Adding a code = adding it here.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: { status: 422, title: 'Validation failed' },
  UNAUTHENTICATED: { status: 401, title: 'Authentication required' },
  FORBIDDEN: { status: 403, title: 'Forbidden' },
  NOT_FOUND: { status: 404, title: 'Not found' },
  CONFLICT: { status: 409, title: 'Conflict' },
  IDEMPOTENCY_KEY_REUSED: { status: 409, title: 'Idempotency key reused with a different request' },
  INVALID_STATE_TRANSITION: { status: 409, title: 'Invalid state transition' },
  RATE_LIMITED: { status: 429, title: 'Too many requests' },
  BUDGET_EXCEEDED: { status: 402, title: 'Budget exceeded' },
  DISCOVERY_PROVIDER_NOT_CONFIGURED: { status: 409, title: 'Discovery provider not configured' },
  SITE_VERSION_CONFLICT: { status: 409, title: 'The site changed since this edit started' },
  ANALYTICS_QUERY_TOO_HEAVY: { status: 422, title: 'The analytics query took too long' },
  EXTERNAL_SERVICE_FAILED: { status: 502, title: 'External service failed' },
  INTERNAL: { status: 500, title: 'Internal error' },
} as const satisfies Record<string, { status: number; title: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;
export const ErrorCodeSchema = z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

export const ERROR_TYPE_BASE = 'https://errors.business-finder.dev/';

export const ProblemFieldErrorSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
  /** A machine-readable cause for this field (e.g. a SiteSpec issue code such as `external_url`). */
  code: z.string().optional(),
});
export type ProblemFieldError = z.infer<typeof ProblemFieldErrorSchema>;

/** RFC 9457 problem details plus our `code`, `traceId` and field `errors`. */
/** The compliance gate did not allow a send: reasons and what to do instead (BF-052; 409 manual-only, 422 blocked). */
export const SendRefusalSchema = z.object({
  decision: z.enum(['manual_only', 'blocked']),
  decisionId: z.uuid().nullable(),
  reasons: z.array(z.object({ code: z.string(), message: z.string() })),
  alternatives: z.array(z.string()),
});
export type SendRefusal = z.infer<typeof SendRefusalSchema>;

export const ProblemDetailsSchema = z
  .object({
    type: z.url(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    code: ErrorCodeSchema,
    /** Finer machine-readable cause within `code` (e.g. `LAST_OWNER`), for clients to show a localized message. */
    reason: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    traceId: z.string().optional(),
    errors: z.array(ProblemFieldErrorSchema).optional(),
    /** `SITE_VERSION_CONFLICT`: the site's current version, to reload before editing again. */
    currentVersionId: z.uuid().optional(),
    /** A send the compliance gate refused (BF-052). */
    refusal: SendRefusalSchema.optional(),
  })
  .meta({ id: 'ProblemDetails', description: 'RFC 9457 problem details (application/problem+json).' });
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export interface DomainErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** Base of every typed error crossing a layer boundary; the API maps it to problem+json once (BF-006). */
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.details = options.details;
  }

  get httpStatus(): number {
    return ERROR_CODES[this.code].status;
  }

  /**
   * `detail` is the error message; 5xx messages are replaced so internals never leak (api.md §4). A
   * `details.reason` in UPPER_SNAKE_CASE becomes `reason`; other details stay server-side.
   */
  toProblem(instance?: string, traceId?: string): ProblemDetails {
    const { status, title } = ERROR_CODES[this.code];
    const reason = this.details?.reason;
    return {
      type: `${ERROR_TYPE_BASE}${this.code}`,
      title,
      status,
      detail: status >= 500 ? title : this.message,
      code: this.code,
      ...(status < 500 && typeof reason === 'string' && /^[A-Z][A-Z0-9_]*$/.test(reason) ? { reason } : {}),
      ...(instance === undefined ? {} : { instance }),
      ...(traceId === undefined ? {} : { traceId }),
    };
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  constructor(entity: string, id: string, options?: DomainErrorOptions) {
    super(`${entity} ${id} not found.`, { ...options, details: { entity, id, ...options?.details } });
  }
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED';
  readonly errors: readonly ProblemFieldError[];

  constructor(message: string, errors: readonly ProblemFieldError[] = [], options?: DomainErrorOptions) {
    super(message, options);
    this.errors = errors;
  }

  static fromZod(error: z.ZodError, message = 'The request is invalid.'): ValidationError {
    return new ValidationError(
      message,
      error.issues.map((issue) => ({
        path: issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
        message: issue.message,
      })),
      { cause: error },
    );
  }

  override toProblem(instance?: string, traceId?: string): ProblemDetails {
    return { ...super.toProblem(instance, traceId), errors: [...this.errors] };
  }
}

export class ConflictError extends DomainError {
  readonly code = 'CONFLICT';
}

/** No valid session or API key (401). */
export class UnauthenticatedError extends DomainError {
  readonly code = 'UNAUTHENTICATED';
  constructor(message = 'Authentication required.', options?: DomainErrorOptions) {
    super(message, options);
  }
}

export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
}

export class InvalidStateTransitionError extends DomainError {
  readonly code = 'INVALID_STATE_TRANSITION';
  constructor(entity: string, from: string, to: string, options?: DomainErrorOptions) {
    super(`${entity} cannot go from "${from}" to "${to}".`, { ...options, details: { entity, from, to } });
  }
}

export class RateLimitedError extends DomainError {
  readonly code = 'RATE_LIMITED';
  readonly retryAfterSeconds: number | undefined;
  constructor(message: string, retryAfterSeconds?: number, options?: DomainErrorOptions) {
    super(message, options);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ExternalServiceError extends DomainError {
  readonly code = 'EXTERNAL_SERVICE_FAILED';
  constructor(service: string, message: string, options?: DomainErrorOptions) {
    super(`${service}: ${message}`, { ...options, details: { service, ...options?.details } });
  }
}

/** A provider was asked to run without its credential: the message names the vault secret to set. */
export class ProviderNotConfiguredError extends DomainError {
  readonly code = 'DISCOVERY_PROVIDER_NOT_CONFIGURED';
  constructor(provider: string, secretName: string) {
    super(`The ${provider} provider needs the "${secretName}" secret (Settings → Integrations).`, {
      details: { reason: 'SECRET_NOT_SET', provider, secretName },
    });
  }
}

export class BudgetExceededError extends DomainError {
  readonly code = 'BUDGET_EXCEEDED';
}
