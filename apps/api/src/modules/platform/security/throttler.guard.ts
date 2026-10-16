import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { getRequestContext } from '../context/request-context.ts';

/** Limits per user when authenticated (BF-010), per client IP otherwise. */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Request): Promise<string> {
    const context = getRequestContext();
    // The client's address behind AUTH_TRUSTED_PROXIES (Express's `req.ip` would be the proxy's: one limit for all).
    return context?.userId ? `user:${context.userId}` : `ip:${context?.ip ?? req.ip ?? 'unknown'}`;
  }
}

/** api.md §8: 300 req/min per user, 60 req/min per anonymous IP. */
export const RATE_LIMITS = { windowMs: 60_000, authenticated: 300, anonymous: 60 } as const;
