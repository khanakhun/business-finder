import type { MailboxProviderKind } from '@bf/contracts';
import { executeWithSignal, policyFor } from '../../../platform/resilience/resilience.ts';
import { MailboxProviderError } from '../../domain/mailbox/errors.ts';

// HTTP for the Gmail, Graph and OAuth endpoints (BF-050): fixed provider hosts only (never user-supplied URLs),
// under the `mailbox-send` (no retry) or `mailbox-api` (retries with jitter) policy with a circuit breaker.
// Provider payloads are never logged or echoed: failures become a typed, credential-free MailboxProviderError.

export interface ProviderResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

const retryAfter = (headers: Headers) => {
  const value = Number(headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

/** Google / Microsoft error reasons in a JSON error body. */
function reasonsOf(body: unknown): string[] {
  const error = (body as { error?: unknown })?.error;
  if (typeof error === 'string') return [error];
  const nested = error as { code?: string; status?: string; errors?: { reason?: string }[] } | undefined;
  return [nested?.code, nested?.status, ...(nested?.errors ?? []).map((e) => e.reason)].filter(
    (value): value is string => typeof value === 'string',
  );
}

export function classifyHttp(
  provider: MailboxProviderKind,
  response: ProviderResponse,
): MailboxProviderError {
  const reasons = reasonsOf(response.body).map((reason) => reason.toLowerCase());
  const after = retryAfter(response.headers);
  if (reasons.includes('invalid_grant'))
    return new MailboxProviderError(
      provider,
      'consent_revoked',
      'Access was revoked: reconnect the mailbox',
      {
        retryable: false,
      },
    );
  if (
    response.status === 401 ||
    reasons.includes('invalid_client') ||
    reasons.includes('unauthorized_client')
  )
    return new MailboxProviderError(provider, 'auth_failed', 'The provider refused the credentials', {
      retryable: false,
    });
  if (reasons.some((reason) => reason.includes('dailylimitexceeded') || reason.includes('quotaexceeded')))
    return new MailboxProviderError(provider, 'quota_exceeded', 'The daily sending quota is used up', {
      retryable: false,
    });
  if (response.status === 429 || reasons.some((reason) => reason.includes('ratelimitexceeded')))
    return new MailboxProviderError(provider, 'rate_limited', 'The provider asked to slow down', {
      ...(after ? { retryAfterSeconds: after } : {}),
    });
  if (response.status === 403)
    return new MailboxProviderError(
      provider,
      'auth_failed',
      'The provider refused the request (permissions)',
      {
        retryable: false,
      },
    );
  if (response.status >= 500)
    return new MailboxProviderError(provider, 'unreachable', 'The provider is unavailable');
  return new MailboxProviderError(
    provider,
    'rejected',
    `The provider refused the request (${response.status})`,
    {
      retryable: false,
    },
  );
}

export async function providerFetch(
  provider: MailboxProviderKind,
  policy: 'mailbox-send' | 'mailbox-api',
  url: string,
  init: RequestInit & { readonly signal?: AbortSignal },
): Promise<ProviderResponse> {
  return executeWithSignal(policyFor(policy), init.signal, async (signal) => {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal, redirect: 'error' });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new MailboxProviderError(provider, 'unreachable', 'The provider could not be reached', {
        cause: error,
      });
    }
    const text = await response.text();
    let body: unknown = text;
    if ((response.headers.get('content-type') ?? '').includes('json') && text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    const result = { status: response.status, headers: response.headers, body };
    if (!response.ok) throw classifyHttp(provider, result);
    return result;
  });
}

export const form = (values: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(values).toString(),
});
