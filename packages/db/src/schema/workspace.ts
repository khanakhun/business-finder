// Workspace context (BF-011): per-workspace settings, the encrypted secrets vault, the append-only audit log.

import type { FeatureFlags, Locale, PostalAddress, SenderDefaults } from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { organization, user } from './auth.ts';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const tz = () => timestamp({ withTimezone: true });

/** One row per workspace, created on first save (readers fall back to defaults). */
export const orgSettings = pgTable('org_settings', {
  organizationId: uuid()
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  agencyName: text(),
  legalName: text(),
  postalAddress: jsonb().$type<PostalAddress>(),
  websiteUrl: text(),
  /** Object key in the assets bucket (`orgs/<orgId>/logo/<id>`). */
  logoAssetKey: text(),
  logoContentType: text(),
  primaryLocale: text().$type<Locale>().notNull().default('en'),
  locales: text().array().$type<Locale[]>().notNull().default(sql`ARRAY['en']::text[]`),
  timezone: text().notNull().default('UTC'),
  /** Country hint for location resolution (BF-017). */
  defaultCountryCode: text(),
  senderDefaults: jsonb().$type<SenderDefaults>().notNull().default({}),
  features: jsonb().$type<FeatureFlags>().notNull().default({}),
  updatedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
  ...timestamps(),
});

/**
 * Envelope-encrypted values (security.md §2): `ciphertext`/`iv`/`auth_tag` under a per-secret data key, which is
 * stored wrapped by master key `key_version` (`wrapped_dek`/`dek_iv`/`dek_tag`).
 */
export const secrets = pgTable(
  'secrets',
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** Registry key (`SECRET_DEFINITIONS` in @bf/contracts). */
    name: text().notNull(),
    ciphertext: bytea().notNull(),
    iv: bytea().notNull(),
    authTag: bytea().notNull(),
    wrappedDek: bytea().notNull(),
    dekIv: bytea().notNull(),
    dekTag: bytea().notNull(),
    keyVersion: integer().notNull(),
    last4: text(),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    ...timestamps(),
    lastUsedAt: tz(),
  },
  (table) => [
    uniqueIndex('secrets_organization_id_name_key').on(table.organizationId, table.name),
    // Rotation scans rows still wrapped by an older master key.
    index('secrets_key_version_idx').on(table.keyVersion),
    check('secrets_key_version_check', sql`${table.keyVersion} >= 1`),
  ],
);

/**
 * Append-only (a trigger rejects UPDATE, DELETE and TRUNCATE). No foreign keys: entries outlive the workspaces,
 * users and keys they mention. `metadata` never holds secret values (redacted on write).
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    /** Null for platform events (e.g. master key rotation). */
    organizationId: uuid(),
    actorType: text().$type<'user' | 'api_key' | 'system'>().notNull(),
    actorId: text(),
    action: text().notNull(),
    entityType: text(),
    entityId: text(),
    ip: inet(),
    userAgent: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: tz().notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_organization_id_occurred_at_idx').on(
      table.organizationId,
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    check('audit_logs_actor_type_check', sql`${table.actorType} IN ('user', 'api_key', 'system')`),
  ],
);
