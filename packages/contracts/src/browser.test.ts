// @vitest-environment happy-dom
// The package must work in browser bundles (apps/web): no Node built-ins at runtime.
import { describe, expect, it } from 'vitest';
import * as contracts from './index.ts';

describe('in a browser environment', () => {
  it('generates ids, signs cursors and validates schemas with Web APIs only', async () => {
    expect(typeof window).toBe('object');
    const id = contracts.newId();
    expect(contracts.isUuidV7(id)).toBe(true);
    const cursor = await contracts.encodeCursor({ sort: ['é'], id }, { secret: 'k' });
    expect(await contracts.decodeCursor(cursor, { secret: 'k' })).toEqual({ sort: ['é'], id });
    expect(contracts.can('viewer', 'business:read')).toBe(true);
  });
});
