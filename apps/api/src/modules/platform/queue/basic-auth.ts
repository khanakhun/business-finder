import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Compare equal-length buffers in constant time; the length check itself leaks only the length.
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * HTTP basic auth for operator pages until RBAC exists. TODO(BF-010): replace with `@RequirePermission`.
 */
export function basicAuth(user: string, password: string, realm: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    const [scheme, encoded = ''] = header.split(' ');
    const [givenUser = '', ...rest] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    if (scheme === 'Basic' && equal(givenUser, user) && equal(rest.join(':'), password)) {
      next();
      return;
    }
    res.setHeader('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    res.status(401).type('text/plain').send('Authentication required');
  };
}
