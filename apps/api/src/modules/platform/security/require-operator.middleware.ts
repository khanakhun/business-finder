import type { NextFunction, Request, Response } from 'express';
import { getRequestAuth } from './auth-context.ts';

/**
 * Express middleware for operator pages outside Nest's router (Bull Board): the same credential resolution as the
 * REST API, then the platform-operator check. Bull Board shows every workspace's jobs, so workspace roles do not
 * qualify. Responds 401/403 in plain text — these are operator pages, not the API.
 */
export function requireOperator() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const resolution = getRequestAuth(req);
    if (resolution.kind !== 'authenticated') {
      res.status(401).type('text/plain').send('Sign in to the dashboard first.');
      return;
    }
    if (resolution.auth.crossOrigin || !resolution.auth.operator) {
      res.status(403).type('text/plain').send('Platform operators only (PLATFORM_OPERATOR_EMAILS).');
      return;
    }
    next();
  };
}
