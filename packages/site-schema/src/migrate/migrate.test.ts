import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMigrator, MigrationError, migrateSpec } from './index.ts';

const salon = JSON.parse(
  readFileSync(new URL('../../fixtures/salon-gustavia.json', import.meta.url), 'utf8'),
);

const code = (run: () => unknown) => {
  try {
    run();
  } catch (caught) {
    return caught instanceof MigrationError ? caught.code : 'other';
  }
  return null;
};

describe('migrateSpec', () => {
  it('reads a current spec as it is', () => {
    expect(migrateSpec(salon)).toEqual(salon);
  });

  it.each([
    ['not an object', [], 'not_a_spec'],
    ['no version', { ...salon, schemaVersion: undefined }, 'unknown_version'],
    ['a newer version', { ...salon, schemaVersion: 2 }, 'future_version'],
    ['an invalid spec', { ...salon, pages: [] }, 'invalid'],
  ])('refuses %s', (_case, input, expected) => {
    expect(code(() => migrateSpec(input))).toBe(expected);
  });
});

describe('createMigrator (the harness future versions use)', () => {
  // A made-up v3 where v1 had `title`, v2 renamed it `name`, and v3 added `tags`.
  const V3 = z.object({ schemaVersion: z.literal(3), name: z.string(), tags: z.array(z.string()) }).strict();
  const migrate = createMigrator(V3, 3, [
    { from: 1, up: ({ title, ...rest }) => ({ ...rest, name: title }) },
    { from: 2, up: (spec) => ({ ...spec, tags: [] }) },
  ]);

  it('runs the upcasters in order up to the latest version', () => {
    expect(migrate({ schemaVersion: 1, title: 'Café' })).toEqual({
      schemaVersion: 3,
      name: 'Café',
      tags: [],
    });
    expect(migrate({ schemaVersion: 2, name: 'Café' })).toEqual({ schemaVersion: 3, name: 'Café', tags: [] });
  });

  it('never changes its input', () => {
    const input = { schemaVersion: 1, title: 'Café' };
    migrate(input);
    expect(input).toEqual({ schemaVersion: 1, title: 'Café' });
  });

  it('needs an upcaster for every step', () => {
    const gap = createMigrator(V3, 3, [{ from: 2, up: (spec) => ({ ...spec, tags: [] }) }]);
    expect(code(() => gap({ schemaVersion: 1, title: 'Café' }))).toBe('missing_upcaster');
  });

  it('refuses upcasters out of range or twice for a version, and reports one that throws', () => {
    expect(() => createMigrator(V3, 3, [{ from: 3, up: (spec) => spec }])).toThrow(/from 1 to 2/);
    expect(() =>
      createMigrator(V3, 3, [
        { from: 1, up: (spec) => spec },
        { from: 1, up: (spec) => spec },
      ]),
    ).toThrow(/same version/);
    const broken = createMigrator(V3, 3, [
      {
        from: 1,
        up: () => {
          throw new Error('boom');
        },
      },
      { from: 2, up: (spec) => ({ ...spec, tags: [] }) },
    ]);
    expect(code(() => broken({ schemaVersion: 1, title: 'Café' }))).toBe('upcaster_failed');
  });
});
