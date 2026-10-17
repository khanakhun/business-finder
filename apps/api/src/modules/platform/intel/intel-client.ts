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

  /**
   * A call answering raw bytes (`POST /v1/image-fetch`): the body, refused past `maxBytes` (intel caps it too).
   * Errors are problem+json, mapped like `post`'s.
   */
  async postForBytes(
    path: string,
    body: unknown,
    options: {
      readonly policy?: ResiliencePolicyName;
      readonly signal?: AbortSignal;
      readonly maxBytes: number;
    },
  ): Promise<Uint8Array> {
    const policy = policyFor(options.policy ?? 'intel');
    return executeWithSignal(policy, options.signal, async (signal) => {
      const response = await this.request(path, body, signal);
      if (!response.ok) throw await this.failure(path, response);
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > options.maxBytes) throw this.tooLarge(path);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > options.maxBytes) throw this.tooLarge(path);
      return bytes;
    });
  }

  private tooLarge(path: string): ExternalServiceError {
    return new ExternalServiceError('intel', `${path} answered more bytes than allowed`, {
      details: { reason: 'TOO_LARGE', retryable: false },
    });
  }

  private async request(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    const env = this.env as ApiEnv;
    const payload = JSON.stringify(body);
    const authorization = await signInternalRequest(
      { method: 'POST', path, body: payload },
      { secret: env.INTEL_SHARED_SECRET },
    );
    return fetch(new URL(path, env.INTEL_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: payload,
      signal,
    });
  }

  private async failure(path: string, response: Response): Promise<ExternalServiceError> {
    const json: unknown = await response.json().catch(() => undefined);
    const code =
      typeof json === 'object' && json && 'code' in json ? String(json.code) : `HTTP_${response.status}`;
    // 4xx: our request is wrong (or unauthorized) — retrying cannot help.
    return new ExternalServiceError('intel', `${path} answered ${response.status}`, {
      details: { reason: code.replace(/[^A-Z0-9_]/g, '_').slice(0, 60), retryable: response.status >= 500 },
    });
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
      // A 4xx's detail is intel's own sentence (e.g. why a model cannot be trained): kept, bounded.
      const detail =
        response.status < 500 &&
        typeof json === 'object' &&
        json &&
        'detail' in json &&
        typeof json.detail === 'string'
          ? `: ${json.detail.slice(0, 300)}`
          : '';
      // 4xx: our request is wrong (or unauthorized) — retrying cannot help.
      throw new ExternalServiceError('intel', `${path} answered ${response.status}${detail}`, {
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
