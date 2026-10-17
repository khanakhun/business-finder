// Call assist (BF-057): generated call scripts, cached per business, offer, language and the facts they rest on (a
// change in the facts produces a new script).

import type { CallScript } from '@bf/contracts';
import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, orgId } from '../columns.ts';
import { organization } from './auth.ts';
import { businesses } from './business-graph.ts';

export const callScripts = pgTable(
  'call_scripts',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    offer: text().notNull(),
    locale: text().$type<'en' | 'fr'>().notNull(),
    factsHash: text().notNull(),
    script: jsonb().$type<Omit<CallScript, 'cached'>>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_call_scripts__key').on(
      table.organizationId,
      table.businessId,
      table.offer,
      table.locale,
      table.factsHash,
    ),
  ],
);
