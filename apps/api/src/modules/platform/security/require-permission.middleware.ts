import type { Permission } from '@bf/contracts';
import type { NextFunction, Request, Response } from 'express';
import { getRequestAuth } from './auth-context.ts';

/**
 * Express middleware for pages outside Nest's router (Bull Board): the same session/API-key resolution as the
 * REST API, then a permission check. Responds 401/403 in plain text — these are operator pages, not the API.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const resolution = getRequestAuth(req);
    if (resolution.kind !== 'authenticated') {
      res.status(401).type('text/plain').send('Sign in to the dashboard first.');
      return;
    }
    const { auth } = resolution;
    if (auth.crossOrigin || !auth.orgId || !auth.permissions.has(permission)) {
      res
        .status(403)
        .type('text/plain')
        .send(`Requires the ${permission} permission in the active workspace.`);
      return;
    }
    next();
  };
}
