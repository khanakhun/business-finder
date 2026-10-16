/** RFC 9457 problem as the API returns it (mirrors @bf/contracts ProblemDetails; kept local for the browser). */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly code: string;
  readonly traceId?: string;
  readonly errors?: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number>;
    readonly message: string;
  }>;
}

/** Thrown by the client for every non-2xx response; `problem` is always populated (synthesised if needed). */
export class ApiError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.problem = problem;
  }

  get status(): number {
    return this.problem.status;
  }

  get code(): string {
    return this.problem.code;
  }
}

function isProblem(value: unknown): value is Problem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === 'string' && typeof v.status === 'number' && typeof v.code === 'string';
}

/** Builds an ApiError from a failed response body; non-problem bodies (proxies, HTML 502s) get a generic problem. */
export function toApiError(status: number, body: unknown, traceId?: string | null): ApiError {
  if (isProblem(body)) return new ApiError(body);
  return new ApiError({
    type: 'about:blank',
    title: status >= 500 ? 'The server could not complete the request' : 'The request was not accepted',
    status,
    code: status >= 500 ? 'INTERNAL' : 'UNKNOWN',
    ...(traceId ? { traceId } : {}),
  });
}

/** Network failure (offline, DNS, CORS): no HTTP status at all. */
export function networkError(cause: unknown): ApiError {
  const error = new ApiError({
    type: 'about:blank',
    title: 'The server could not be reached',
    status: 0,
    code: 'NETWORK',
  });
  (error as { cause?: unknown }).cause = cause;
  return error;
}
