import type { z } from 'zod';
import { SITE_SCHEMA_VERSION, type SiteSpec, SiteSpecSchema } from '../spec/site.ts';

// Spec migrations (BF-033): stored versions stay renderable as the schema evolves. Each upcaster turns version n into
// n + 1; `migrateSpec` runs them from the input's `schemaVersion` up to the current one, then parses.

export interface Upcaster {
  /** The version it reads (it writes `from + 1`). */
  readonly from: number;
  readonly up: (spec: Record<string, unknown>) => Record<string, unknown>;
}

export class MigrationError extends Error {
  constructor(
    readonly code:
      | 'not_a_spec'
      | 'unknown_version'
      | 'future_version'
      | 'missing_upcaster'
      | 'upcaster_failed'
      | 'invalid',
    message: string,
    readonly issues: readonly z.core.$ZodIssue[] = [],
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** A migrator for a schema at version `latest` (exported for future versions' tests). */
export function createMigrator<T>(schema: z.ZodType<T>, latest: number, upcasters: readonly Upcaster[]) {
  for (const upcaster of upcasters) {
    if (!Number.isInteger(upcaster.from) || upcaster.from < 1 || upcaster.from >= latest) {
      throw new Error(`An upcaster reads a version from 1 to ${latest - 1}, not ${upcaster.from}.`);
    }
  }
  const byVersion = new Map(upcasters.map((upcaster) => [upcaster.from, upcaster]));
  if (byVersion.size !== upcasters.length) throw new Error('Two upcasters read the same version.');
  return (input: unknown): T => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new MigrationError('not_a_spec', 'A spec is an object.');
    let spec = structuredClone(input) as Record<string, unknown>;
    const version = spec.schemaVersion;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new MigrationError('unknown_version', 'The spec has no valid schemaVersion.');
    }
    if (version > latest)
      throw new MigrationError('future_version', `Version ${version} is newer than this code (${latest}).`);
    for (let from = version; from < latest; from += 1) {
      const upcaster = byVersion.get(from);
      if (!upcaster) throw new MigrationError('missing_upcaster', `No upcaster from version ${from}.`);
      try {
        spec = { ...upcaster.up(spec), schemaVersion: from + 1 };
      } catch (caught) {
        throw new MigrationError(
          'upcaster_failed',
          `Upcasting from version ${from} failed: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
    }
    const parsed = schema.safeParse(spec);
    if (!parsed.success)
      throw new MigrationError(
        'invalid',
        'The migrated spec does not match the schema.',
        parsed.error.issues,
      );
    return parsed.data;
  };
}

/** Upcasters of SiteSpec (v1 is the baseline: none yet). */
export const SITE_UPCASTERS: readonly Upcaster[] = [];

/** Any stored spec, as the current version. */
export const migrateSpec: (input: unknown) => SiteSpec = createMigrator(
  SiteSpecSchema,
  SITE_SCHEMA_VERSION,
  SITE_UPCASTERS,
);
