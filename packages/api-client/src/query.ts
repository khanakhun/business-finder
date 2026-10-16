import type { QueryKey } from '@tanstack/react-query';
import { ApiError } from './errors.ts';

/**
 * Query-key convention: `[resource, scope, …params]`, e.g. `['system', 'info']`, `['businesses', 'list', filters]`.
 * Invalidate by prefix: `queryClient.invalidateQueries({ queryKey: queryKeys.businesses.all })`.
 */
export function defineQueryKeys<
  const R extends string,
  const S extends Record<string, (...args: never[]) => QueryKey>,
>(resource: R, scopes: S): { readonly all: readonly [R] } & S {
  return { all: [resource] as const, ...scopes };
}

/** Retry policy: never retry client errors or non-idempotent requests; retry GETs on network/5xx twice. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (error instanceof ApiError) return error.status === 0 || error.status >= 500;
  return false;
}
