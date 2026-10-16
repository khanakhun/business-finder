// Identity tables for Better Auth (BF-010). Generated with the Better Auth CLI (`auth generate`, v1.7.8, plugins:
// organization, twoFactor, apiKey with references: 'organization', rateLimit storage: database) and adapted to the
// repo conventions (ARCHITECTURE.md §6.2): plural snake_case table names, UUIDv7 keys supplied by the app,
// timestamptz, real foreign keys for the organization references Better Auth stores as plain strings.
//
// Export names must stay the Better Auth model names (`user`, `apikey`, …): the Drizzle adapter looks tables up
// by them. When upgrading Better Auth, re-run the generator and diff field lists against this file.

import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id } from '../columns.ts';

const tz = () => timestamp({ withTimezone: true });
const createdAt = () => tz().notNull().defaultNow();
const updatedAt = () =>
  tz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const user = pgTable('users', {
  id: id(),
  name: text().notNull(),
  // Better Auth lower-cases emails before storing them.
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  twoFactorEnabled: boolean().default(false),
  /** UI and system-email language (`en` | `fr`). */
  locale: text().default('en'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const organization = pgTable('organizations', {
  id: id(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  metadata: text(),
  createdAt: createdAt(),
});

export const session = pgTable(
  'sessions',
  {
    id: id(),
    token: text().notNull().unique(),
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    activeOrganizationId: uuid().references(() => organization.id, { onDelete: 'set null' }),
    expiresAt: tz().notNull(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const account = pgTable(
  'accounts',
  {
    id: id(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: tz(),
    refreshTokenExpiresAt: tz(),
    scope: text(),
    /** Password hash (scrypt, Better Auth default) for the `credential` provider. */
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('accounts_user_id_idx').on(t.userId)],
);

export const verification = pgTable(
  'verifications',
  {
    id: id(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: tz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
);

export const member = pgTable(
  'members',
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** owner | admin | member | viewer (@bf/contracts ROLES). */
    role: text().notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('members_organization_id_user_id_key').on(t.organizationId, t.userId),
    index('members_user_id_idx').on(t.userId),
  ],
);

export const invitation = pgTable(
  'invitations',
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    role: text(),
    /** pending | accepted | rejected | canceled */
    status: text().notNull().default('pending'),
    inviterId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: tz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('invitations_organization_id_idx').on(t.organizationId),
    index('invitations_email_idx').on(t.email),
  ],
);

export const twoFactor = pgTable(
  'two_factors',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Encrypted by Better Auth with BETTER_AUTH_SECRET. */
    secret: text().notNull(),
    backupCodes: text().notNull(),
    verified: boolean().default(true),
    failedVerificationCount: integer().default(0),
    lockedUntil: tz(),
  },
  (t) => [index('two_factors_user_id_idx').on(t.userId)],
);

export const apikey = pgTable(
  'api_keys',
  {
    id: id(),
    configId: text().notNull().default('default'),
    name: text(),
    /** First characters of the key, shown in lists (`bf_ab12…`). */
    start: text(),
    prefix: text(),
    /** SHA-256 of the key; the key itself is shown once at creation. */
    key: text().notNull(),
    /** Owning organization (the plugin runs with `references: 'organization'`). */
    referenceId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    refillInterval: integer(),
    refillAmount: integer(),
    lastRefillAt: tz(),
    enabled: boolean().default(true),
    rateLimitEnabled: boolean().default(true),
    rateLimitTimeWindow: integer().default(86_400_000),
    rateLimitMax: integer().default(10),
    requestCount: integer().default(0),
    remaining: integer(),
    lastRequest: tz(),
    expiresAt: tz(),
    /** Better Auth statements JSON, e.g. {"business":["read"]} — a subset of the creator's permissions. */
    permissions: text(),
    /** JSON: created_by, revoked_at… */
    metadata: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('api_keys_key_key').on(t.key),
    index('api_keys_reference_id_idx').on(t.referenceId),
    index('api_keys_config_id_idx').on(t.configId),
  ],
);

/** Auth endpoint rate-limit counters (shared by every API instance). */
export const rateLimit = pgTable('rate_limits', {
  id: id(),
  key: text().notNull().unique(),
  count: integer().notNull(),
  lastRequest: bigint({ mode: 'number' }).notNull(),
});

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  invitations: many(invitation),
  twoFactors: many(twoFactor),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, { fields: [member.organizationId], references: [organization.id] }),
  user: one(user, { fields: [member.userId], references: [user.id] }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, { fields: [invitation.organizationId], references: [organization.id] }),
  user: one(user, { fields: [invitation.inviterId], references: [user.id] }),
}));

export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
  user: one(user, { fields: [twoFactor.userId], references: [user.id] }),
}));
