import { AsyncLocalStorage } from 'node:async_hooks';
import type { ApiEnv } from '@bf/config';
import { newId } from '@bf/contracts';
import { withLogContext } from '@bf/observability';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { APP_ENV, type AppEnv } from '../config/app-env.ts';
import { type AuthContext, getRequestAuth } from '../security/auth-context.ts';
import { clientIp, trustedProxyMatcher } from '../security/client-ip.ts';

/** Per-request facts available anywhere in the call chain (ARCHITECTURE §5.3). */
export interface RequestContext {
  readonly requestId: string;
  /** The authenticated caller, if any (resolved before Nest middleware, see http.ts). */
  readonly auth?: AuthContext;
  readonly orgId?: string;
  readonly userId?: string;
  /** Client address (behind AUTH_TRUSTED_PROXIES) and User-Agent, for the audit log. */
  readonly ip?: string;
  readonly userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Runs `fn` with this request's context minus the client's address and user agent: an anonymous public write whose
 * records (events, audit) must never keep them (BF-048 leads).
 */
export function withoutClientDetails<T>(fn: () => T): T {
  const current = storage.getStore();
  if (!current) return fn();
  const { ip: _ip, userAgent: _userAgent, ...rest } = current;
  return storage.run(rest, fn);
}

export const REQUEST_ID_HEADER = 'x-request-id';
// Accept a caller's id only if it is short and safe to echo into logs and headers.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value && SAFE_REQUEST_ID.test(value) ? value : newId();
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly isTrustedProxy: (ip: string) => boolean;

  constructor(@Inject(APP_ENV) env: AppEnv) {
    this.isTrustedProxy = trustedProxyMatcher((env as Partial<ApiEnv>).AUTH_TRUSTED_PROXIES ?? []);
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const resolution = getRequestAuth(req);
    const auth = resolution.kind === 'authenticated' ? resolution.auth : undefined;
    const ids = {
      ...(auth?.userId ? { userId: auth.userId } : {}),
      ...(auth?.orgId ? { orgId: auth.orgId } : {}),
    };
    const ip = clientIp(req, this.isTrustedProxy);
    const userAgent = req.headers['user-agent']?.slice(0, 512);
    const client = { ...(ip ? { ip } : {}), ...(userAgent ? { userAgent } : {}) };
    storage.run({ requestId, ...(auth ? { auth } : {}), ...ids, ...client }, () =>
      withLogContext({ requestId, ...ids }, next),
    );
  }
}
