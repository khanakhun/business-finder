import { AsyncLocalStorage } from 'node:async_hooks';
import { newId } from '@bf/contracts';
import { withLogContext } from '@bf/observability';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** Per-request facts available anywhere in the call chain (ARCHITECTURE §5.3). Auth fields arrive in BF-010. */
export interface RequestContext {
  readonly requestId: string;
  readonly orgId?: string;
  readonly userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
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
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    storage.run({ requestId }, () => withLogContext({ requestId }, next));
  }
}
