import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from './errors.ts';
import { CursorPageRequestSchema, cursorPage, decodeCursor, encodeCursor } from './pagination.ts';

const data = { sort: [87.5, 'Café', null, true], id: '0192f3e4-5b6c-7d8e-9f01-23456789abcd' };

describe('CursorPageRequestSchema', () => {
  it('defaults and coerces query-string limits', () => {
    expect(CursorPageRequestSchema.parse({})).toEqual({ limit: 50 });
    expect(CursorPageRequestSchema.parse({ limit: '200', cursor: 'abc' })).toEqual({
      limit: 200,
      cursor: 'abc',
    });
  });

  it.each(['0', '201', '1.5', 'x'])('rejects limit=%s', (limit) => {
    expect(CursorPageRequestSchema.safeParse({ limit }).success).toBe(false);
  });
});

describe('cursorPage', () => {
  it('builds a page schema around an item schema', () => {
    const page = cursorPage(z.object({ name: z.string() }));
    expect(page.parse({ items: [{ name: 'a' }], nextCursor: null })).toEqual({
      items: [{ name: 'a' }],
      nextCursor: null,
    });
    expect(page.safeParse({ items: [{ name: 1 }], nextCursor: null }).success).toBe(false);
  });
});

describe('cursors', () => {
  it('round-trip, including non-ASCII sort values', async () => {
    const cursor = await encodeCursor(data);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decodeCursor(cursor)).toEqual(data);
  });

  it('round-trip when signed', async () => {
    const cursor = await encodeCursor(data, { secret: 's3cret' });
    expect(cursor.split('.')).toHaveLength(2);
    expect(await decodeCursor(cursor, { secret: 's3cret' })).toEqual(data);
  });

  it('reject tampered signed cursors', async () => {
    const cursor = await encodeCursor(data, { secret: 's3cret' });
    const [, signature] = cursor.split('.');
    const forged = `${await encodeCursor({ ...data, id: 'someone-else' })}.${signature}`;
    await expect(decodeCursor(forged, { secret: 's3cret' })).rejects.toThrow(ValidationError);
    await expect(decodeCursor(cursor, { secret: 'other' })).rejects.toThrow(ValidationError);
    await expect(decodeCursor(cursor.split('.')[0] ?? '', { secret: 's3cret' })).rejects.toThrow(
      ValidationError,
    );
  });

  it.each([
    ['not base64url', '***'],
    ['impossible length', 'abcde'],
    ['not JSON', btoa('{nope').replaceAll('=', '')],
    ['wrong shape', btoa(JSON.stringify({ sort: 'x', id: 1 })).replaceAll('=', '')],
    ['invalid UTF-8', '_w'],
    ['signature without a secret', 'abc.def'],
    ['too many parts', 'a.b.c'],
  ])('reject malformed cursors: %s', async (_label, cursor) => {
    await expect(decodeCursor(cursor)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: ['cursor'] }],
    });
  });

  it('refuse to encode invalid data', async () => {
    await expect(encodeCursor({ sort: [], id: '' })).rejects.toThrow();
  });
});
