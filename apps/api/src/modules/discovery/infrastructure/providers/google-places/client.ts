import { ExternalServiceError, RateLimitedError } from '@bf/contracts';
import { z } from 'zod';

// Places API (New) HTTP adapter (README "Endpoints", "Error handling"). The key travels in a header only and is
// never logged or put in error messages.

export const PLACES_BASE_URL = 'https://places.googleapis.com/v1';
const TIMEOUT_MS = 10_000;

const ErrorBody = z.object({
  error: z.object({
    code: z.number().optional(),
    status: z.string().optional(),
    message: z.string().optional(),
  }),
});

export const SearchResponseSchema = z.object({
  // A page holds at most 20 places: anything beyond is ignored.
  places: z
    .array(z.unknown())
    .default([])
    .transform((places) => places.slice(0, 20)),
  nextPageToken: z.string().max(4_000).optional(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/** Seconds from a `Retry-After` header (delta seconds or HTTP date), bounded to a minute. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const value = Number.isFinite(seconds) ? seconds : (Date.parse(header) - now) / 1000;
  return Number.isFinite(value) && value >= 0 ? Math.min(60, Math.ceil(value)) : undefined;
}

export class GooglePlacesClient {
  constructor(private readonly baseUrl: string = PLACES_BASE_URL) {}

  searchText(body: object, fieldMask: string, key: string, signal: AbortSignal): Promise<SearchResponse> {
    return this.post('places:searchText', body, fieldMask, key, signal);
  }

  searchNearby(body: object, fieldMask: string, key: string, signal: AbortSignal): Promise<SearchResponse> {
    return this.post('places:searchNearby', body, fieldMask, key, signal);
  }

  private async post(
    method: string,
    body: object,
    fieldMask: string,
    key: string,
    signal: AbortSignal,
  ): Promise<SearchResponse> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fieldMask },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    const json: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw this.toError(response, json);
    // A 2xx without JSON is a transient upstream glitch (retry); a JSON body of the wrong shape is not.
    if (json === undefined) throw new ExternalServiceError('google-places', 'answered without JSON');
    const parsed = SearchResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ExternalServiceError('google-places', 'unexpected response', {
        details: { reason: 'UNEXPECTED_RESPONSE', retryable: false },
      });
    }
    return parsed.data;
  }

  private toError(response: Response, json: unknown): Error {
    // Only a sanitized, bounded status goes into messages and details (never the provider's free text).
    const status = (ErrorBody.safeParse(json).data?.error.status ?? `HTTP_${response.status}`)
      .replace(/[^A-Z0-9_]/g, '_')
      .slice(0, 60);
    if (response.status === 429) {
      return new RateLimitedError(
        'Google Places quota reached.',
        retryAfterSeconds(response.headers.get('retry-after')),
      );
    }
    // 4xx are configuration or request errors: retrying cannot help (and must not trip the breaker).
    const retryable = response.status >= 500;
    return new ExternalServiceError('google-places', `answered ${response.status} ${status}`, {
      details: { reason: status, retryable },
    });
  }
}
