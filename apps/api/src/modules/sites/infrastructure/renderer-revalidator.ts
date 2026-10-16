import type { ApiEnv } from '@bf/config';
import { ExternalServiceError, type SiteRevalidateRequest, signInternalRequest } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import { executeWithSignal, policyFor } from '../../platform/resilience/resilience.ts';

export const REVALIDATE_PATH = '/api/revalidate';

/**
 * Asks the site renderer (apps/sites, BF-036) to refresh cached pages: `POST <SITES_INTERNAL_URL>/api/revalidate`,
 * signed like every internal call (HMAC over method, path and body). Without a secret (local development) nothing is
 * sent; production refuses to start without one.
 */
@Injectable()
export class RendererRevalidator {
  private readonly url: string;
  private readonly secret: string | undefined;

  constructor(
    @Inject(APP_ENV) env: AppEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    const api = env as ApiEnv;
    this.url = new URL(REVALIDATE_PATH, api.SITES_INTERNAL_URL).href;
    this.secret = api.SITES_REVALIDATE_SECRET;
    if (!this.secret && api.NODE_ENV === 'production')
      throw new Error(
        'SITES_REVALIDATE_SECRET is required in production (the renderer would serve stale pages).',
      );
  }

  async revalidate(request: SiteRevalidateRequest, signal?: AbortSignal): Promise<'sent' | 'skipped'> {
    if (!this.secret) {
      this.logger.debug({ tags: request.tags }, 'site revalidation skipped (no SITES_REVALIDATE_SECRET)');
      return 'skipped';
    }
    const secret = this.secret;
    const body = JSON.stringify(request);
    await executeWithSignal(policyFor('sites-revalidate'), signal, async (attempt) => {
      const authorization = await signInternalRequest(
        { method: 'POST', path: REVALIDATE_PATH, body },
        { secret },
      );
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body,
        signal: attempt,
      });
      if (!response.ok)
        throw new ExternalServiceError('sites-renderer', `Revalidation answered ${response.status}`);
    });
    return 'sent';
  }
}
