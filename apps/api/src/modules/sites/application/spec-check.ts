import type { SiteIssue } from '@bf/contracts';
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

/** A spec as the current schema version, valid, with its warnings; else `SiteSpecInvalidError`. */
export function checkSpec(input: unknown, hosting: SiteHosting): { spec: SiteSpec; warnings: SiteIssue[] } {
  let candidate = input;
  const version =
    typeof input === 'object' && input !== null
      ? (input as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (typeof version === 'number' && version !== SITE_SCHEMA_VERSION) {
    try {
      candidate = migrateSpec(input);
    } catch (error) {
      // An invalid migrated spec is reported issue by issue below; anything else cannot be read at all.
      if (!(error instanceof MigrationError) || error.code !== 'invalid') {
        const message = error instanceof Error ? error.message : 'The spec cannot be read.';
        const code = error instanceof MigrationError ? error.code : 'unreadable';
        throw new SiteSpecInvalidError([{ path: ['schemaVersion'], message, code }]);
      }
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
