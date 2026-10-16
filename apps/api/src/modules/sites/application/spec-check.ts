import { SITE_SPEC_MAX_BYTES, type SiteIssue } from '@bf/contracts';
import {
  type Issue,
  MigrationError,
  migrateSpec,
  parseSite,
  SITE_SCHEMA_VERSION,
  type SiteSpec,
  validateSite,
} from '@bf/site-schema';
import { SiteSpecInvalidError } from '../domain/errors.ts';
import type { SiteHosting } from './ports.ts';

// Every spec that becomes a version, or is published, passes here (BF-035): upcast to the current schema version,
// then the BF-033 validators. Errors refuse it (422, each at its path with its code); warnings are kept with it.
// DECISION(BF-035): facts validation (strict mode) waits for the fact registry (BF-040), which is not stored yet.

const toIssue = (issue: Issue): SiteIssue => ({
  path: [...issue.path],
  code: issue.code,
  severity: issue.severity,
  message: issue.message,
});

/** The largest spec a version may hold, in UTF-8 bytes (a full 8-page site is well under 300 kB). */
export const MAX_SPEC_BYTES = SITE_SPEC_MAX_BYTES;

/** A spec as the current schema version, valid, with its warnings; else `SiteSpecInvalidError`. */
export function checkSpec(input: unknown, hosting: SiteHosting): { spec: SiteSpec; warnings: SiteIssue[] } {
  if (Buffer.byteLength(JSON.stringify(input ?? null), 'utf8') > MAX_SPEC_BYTES) {
    throw new SiteSpecInvalidError([
      { path: [], message: `The site is larger than ${MAX_SPEC_BYTES} bytes.`, code: 'too_large' },
    ]);
  }
  let candidate = input;
  const version =
    typeof input === 'object' && input !== null
      ? (input as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (typeof version === 'number' && version !== SITE_SCHEMA_VERSION) {
    try {
      candidate = migrateSpec(input);
    } catch (error) {
      // The migrated spec's own problems are reported at their paths; anything else cannot be read at all.
      if (error instanceof MigrationError && error.code === 'invalid') {
        throw new SiteSpecInvalidError(
          error.issues.map((issue) => ({
            path: issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
            message: issue.message,
            code: issue.code,
          })),
        );
      }
      const message = error instanceof Error ? error.message : 'The spec cannot be read.';
      const code = error instanceof MigrationError ? error.code : 'unreadable';
      throw new SiteSpecInvalidError([{ path: ['schemaVersion'], message, code }]);
    }
  }
  // Versions serve previews and live sites alike: the renderer enforces the preview's robots and banner (BF-036).
  const issues = validateSite(candidate, { assetHosts: hosting.assetHosts, mode: 'published' });
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new SiteSpecInvalidError(
      errors.map((issue) => ({ path: [...issue.path], message: issue.message, code: issue.code })),
    );
  }
  const { spec } = parseSite(candidate);
  if (!spec) throw new SiteSpecInvalidError([{ path: [], message: 'The spec does not match the schema.' }]);
  return { spec, warnings: issues.map(toIssue) };
}
