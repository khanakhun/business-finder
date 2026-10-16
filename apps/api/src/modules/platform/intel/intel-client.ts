import type { ApiEnv } from '@bf/config';
import { ExternalServiceError, signInternalRequest } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { APP_ENV, type AppEnv } from '../config/app-env.ts';
import { executeWithSignal, policyFor, type ResiliencePolicyName } from '../resilience/resilience.ts';

/**
 * Signed calls to services/intel (ADR-0002, BF-008 auth): `Authorization` HMAC over method, path and body
 * hash; responses validated against the shared contract; timeouts, retries and a breaker per policy.
 */
@Injectable()
export class IntelClient {
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  async post<S extends z.ZodType>(
    path: string,
    body: unknown,
    responseSchema: S,
    options: { readonly policy?: ResiliencePolicyName; readonly signal?: AbortSignal } = {},
  ): Promise<z.output<S>> {
    const policy = policyFor(options.policy ?? 'intel');
    return executeWithSignal(policy, options.signal, (signal) =>
      this.send(path, body, responseSchema, signal),
    );
  }

  private async send<S extends z.ZodType>(
    path: string,
    body: unknown,
    responseSchema: S,
    signal: AbortSignal,
  ): Promise<z.output<S>> {
    const env = this.env as ApiEnv;
    const payload = JSON.stringify(body);
    const authorization = await signInternalRequest(
      { method: 'POST', path, body: payload },
      { secret: env.INTEL_SHARED_SECRET },
    );
    const response = await fetch(new URL(path, env.INTEL_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: payload,
      signal,
    });
    const json: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code =
        typeof json === 'object' && json && 'code' in json ? String(json.code) : `HTTP_${response.status}`;
      // 4xx: our request is wrong (or unauthorized) — retrying cannot help.
      throw new ExternalServiceError('intel', `${path} answered ${response.status}`, {
        details: { reason: code.replace(/[^A-Z0-9_]/g, '_').slice(0, 60), retryable: response.status >= 500 },
      });
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ExternalServiceError('intel', `${path} returned an unexpected body`, {
        details: { retryable: false },
      });
    }
    return parsed.data;
  }
}
