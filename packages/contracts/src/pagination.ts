import { z } from 'zod';
import { constantTimeEqual, fromBase64Url, hmacSha256, toBase64Url } from './encoding.ts';
import { ValidationError } from './errors.ts';

/** `?limit=50&cursor=<opaque>` (api.md §3). `limit` is coerced because it arrives as a query string. */
export const CursorPageRequestSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type CursorPageRequest = z.infer<typeof CursorPageRequestSchema>;

/** `{ items, nextCursor, totalEstimate? }` for a given item schema. */
export function cursorPage<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    totalEstimate: z.number().int().nonnegative().optional(),
  });
}

const CursorDataSchema = z.object({
  sort: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  id: z.string().min(1),
});
/** Position after the last item of a page: its sort key values and id (tie-breaker). */
export type CursorData = z.infer<typeof CursorDataSchema>;

export interface CursorOptions {
  /** When set, cursors carry an HMAC-SHA256 signature and tampered cursors are rejected. */
  readonly secret?: string;
}

const SIGNATURE_SEPARATOR = '.';

export async function encodeCursor(data: CursorData, options: CursorOptions = {}): Promise<string> {
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(CursorDataSchema.parse(data))));
  if (!options.secret) return body;
  return `${body}${SIGNATURE_SEPARATOR}${toBase64Url(await hmacSha256(options.secret, body))}`;
}

/** @throws ValidationError for malformed, unsigned (when a secret is set) or tampered cursors. */
export async function decodeCursor(cursor: string, options: CursorOptions = {}): Promise<CursorData> {
  const invalid = () =>
    new ValidationError('Invalid cursor.', [{ path: ['cursor'], message: 'Invalid cursor' }]);
  const [body = '', signature, ...rest] = cursor.split(SIGNATURE_SEPARATOR);
  if (rest.length > 0) throw invalid();
  if (options.secret) {
    const given = signature === undefined ? undefined : fromBase64Url(signature);
    if (!given || !constantTimeEqual(given, await hmacSha256(options.secret, body))) throw invalid();
  } else if (signature !== undefined) {
    throw invalid();
  }
  const bytes = fromBase64Url(body);
  if (!bytes) throw invalid();
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalid();
  }
  const parsed = CursorDataSchema.safeParse(json);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
