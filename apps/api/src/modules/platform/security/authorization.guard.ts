import { ForbiddenError, UnauthenticatedError } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { LOGGER } from '../logging/logger.ts';
import { ACCESS_POLICY, type AccessPolicy } from './auth.decorators.ts';
import { getRequestAuth } from './auth-context.ts';

/**
 * Enforces each route's declared access policy (credentials were resolved earlier, in the middleware from
 * http.ts). 401: no or invalid credentials. 403: no workspace, missing permission, or a cross-origin session write.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request>();
    if (!policy) {
      this.logger.error({ route: req.route?.path }, 'route declares no access policy; refused');
      throw new ForbiddenError('This route is not available.');
    }
    if (policy.kind === 'anonymous') return true;

    const resolution = getRequestAuth(req);
    if (resolution.kind !== 'authenticated') {
      throw new UnauthenticatedError(
        resolution.kind === 'invalid'
          ? 'The credentials are invalid or expired.'
          : 'Authentication required.',
      );
    }
    const { auth } = resolution;
    if (auth.crossOrigin) throw new ForbiddenError('Cross-origin request refused.');
    if (policy.kind === 'operator') {
      if (!auth.operator) throw new ForbiddenError('Platform operators only.');
      return true;
    }
    const orgRequired = policy.kind === 'permissions' || policy.orgRequired;
    if (orgRequired && !auth.orgId) throw new ForbiddenError('Select a workspace first.');
    if (policy.kind === 'permissions') {
      const missing = policy.permissions.filter((p) => !auth.permissions.has(p));
      if (missing.length > 0) {
        throw new ForbiddenError('You do not have permission to do this.', { details: { missing } });
      }
    }
    return true;
  }
}
