// Discovery context (BF-018): provider usage metering. Runs and tasks come with BF-020.

import { DISCOVERY_PROVIDER_IDS, type ProviderId } from '@bf/contracts';
import { sql } from 'drizzle-orm';
import { check, date, index, integer, numeric, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '../columns.ts';
import { organization } from './auth.ts';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * Calls, results and estimated cost per workspace, provider, SKU and UTC day. `billing_scope` is whose provider
 * account paid (the workspace id for its own key, `global` for the deployment key): free monthly allowances are
 * per account, so they are counted per scope.
 */
export const providerUsage = pgTable(
  'provider_usage',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    provider: text().$type<ProviderId>().notNull(),
    sku: text().notNull(),
    day: date({ mode: 'string' }).notNull(),
    billingScope: text().notNull(),
    calls: integer().notNull().default(0),
    results: integer().notNull().default(0),
    costUsd: numeric({ precision: 12, scale: 6, mode: 'number' }).notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    primaryKey({
      name: 'provider_usage_pkey',
      columns: [table.organizationId, table.provider, table.sku, table.day, table.billingScope],
    }),
    // Free-allowance sums per account and month.
    index('idx_provider_usage__billing_scope_provider_sku_day').on(
      table.billingScope,
      table.provider,
      table.sku,
      table.day,
    ),
    check('ck_provider_usage__provider', sql`${table.provider} IN (${inList(DISCOVERY_PROVIDER_IDS)})`),
    check(
      'ck_provider_usage__counts',
      sql`${table.calls} >= 0 AND ${table.results} >= 0 AND ${table.costUsd} >= 0`,
    ),
  ],
);
