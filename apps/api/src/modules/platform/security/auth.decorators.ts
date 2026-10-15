import { type Permission, UnauthenticatedError } from '@bf/contracts';
import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { type AuthContext, getRequestAuth } from './auth-context.ts';

/**
 * Every route declares its access policy with exactly one of these; a route without one is refused (fail closed)
 * and `routes.test.ts` fails, so a forgotten decorator cannot ship an open endpoint.
 */
export type AccessPolicy =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'authenticated'; readonly orgRequired: boolean }
  | { readonly kind: 'permissions'; readonly permissions: readonly Permission[] }
  | { readonly kind: 'operator' };

export const ACCESS_POLICY = 'bf:access-policy';

/** Public route (health, metrics, …). Listed in apps/api/README.md. */
export const AllowAnonymous = () => SetMetadata(ACCESS_POLICY, { kind: 'anonymous' } satisfies AccessPolicy);

/** Any authenticated caller with an active workspace holding all of `permissions` (api.md §2). */
export const RequirePermission = (...permissions: [Permission, ...Permission[]]) =>
  SetMetadata(ACCESS_POLICY, { kind: 'permissions', permissions } satisfies AccessPolicy);

/**
 * Any signed-in caller, even without an active workspace (e.g. `GET /v1/me`, switching workspace). Use only for
 * routes that act on the caller themselves.
 */
export const NoOrgRequired = () =>
  SetMetadata(ACCESS_POLICY, { kind: 'authenticated', orgRequired: false } satisfies AccessPolicy);

/**
 * Cross-workspace operator tools (queue smoke tests, …): platform operators only, never workspace roles or API
 * keys — a workspace owner must not see other workspaces' data.
 */
export const OperatorOnly = () => SetMetadata(ACCESS_POLICY, { kind: 'operator' } satisfies AccessPolicy);

/** The resolved caller; only valid on routes that are not anonymous (the guard guarantees it). */
export const Ctx = createParamDecorator((_: unknown, host: ExecutionContext): AuthContext => {
  const resolution = getRequestAuth(host.switchToHttp().getRequest<Request>());
  if (resolution.kind !== 'authenticated') throw new UnauthenticatedError();
  return resolution.auth;
});
