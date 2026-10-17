import { type DbClient, getExecutor, runInTransaction } from '@bf/db';
import { Inject, Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { FactScope, FactSourceName, FactsQuery, FactsStore, PayloadFact } from '../application/ports.ts';
import { AnalyticsQueryTooHeavyError } from '../domain/errors.ts';
import { semanticRegistry } from '../semantic/registry.ts';
import { insertFacts, SOURCES } from './fact-sources.ts';
import { compileQuery } from './sql-compiler.ts';

// The facts store (BF-058): ingestion through the fact sources' insert, queries under a statement timeout (a
// cancelled query becomes a friendly error), and the labels of dimension values.

/** A bound parameter per value (Drizzle would expand an array into a row). */
const list = (values: string[]) =>
  sql.join(
    values.map((value) => sql`${value}::text`),
    sql`, `,
  );

const LABELS: Record<string, (org: string, values: string[], locale: 'en' | 'fr') => SQL> = {
  category: (_org, values, locale) =>
    sql`SELECT path::text AS value, labels ->> ${locale} AS label FROM categories WHERE path::text IN (${list(values)})`,
  subcategory: (_org, values, locale) =>
    sql`SELECT path::text AS value, labels ->> ${locale} AS label FROM categories WHERE path::text IN (${list(values)})`,
  area: (_org, values, locale) =>
    sql`SELECT id::text AS value, coalesce(name ->> ${locale}, name ->> 'en') AS label
      FROM geo_areas WHERE id::text IN (${list(values)})`,
  template: (org, values) =>
    sql`SELECT DISTINCT ON (id) id::text AS value, name AS label FROM email_templates
      WHERE id::text IN (${list(values)}) AND (organization_id IS NULL OR organization_id = ${org}::uuid)`,
  template_version: (org, values) =>
    sql`SELECT id::text || ':' || version::text AS value, name || ' v' || version AS label FROM email_templates
      WHERE id::text || ':' || version::text IN (${list(values)})
        AND (organization_id IS NULL OR organization_id = ${org}::uuid)`,
  mailbox: (org, values) =>
    sql`SELECT id::text AS value, email AS label FROM mailboxes
      WHERE id::text IN (${list(values)}) AND organization_id = ${org}::uuid`,
  creator: (org, values) =>
    sql`SELECT u.id::text AS value, u.name AS label FROM users u
      JOIN members m ON m.user_id = u.id AND m.organization_id = ${org}::uuid
      WHERE u.id::text IN (${list(values)})`,
};

@Injectable()
export class DrizzleFactsStore implements FactsStore {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private async insert(source: SQL): Promise<number> {
    const result = await getExecutor(this.db).execute(insertFacts(source));
    return (result as unknown as { count?: number }).count ?? 0;
  }

  ingest(source: FactSourceName, scope: FactScope): Promise<number> {
    return this.insert(SOURCES[source](scope));
  }

  ingestPayload(fact: PayloadFact): Promise<number> {
    return this.insert(SOURCES.fromPayload(fact));
  }

  ingestBounce(scope: FactScope, bounce: { at: Date; permanent: boolean }): Promise<number> {
    return this.insert(SOURCES.emailBounced(scope, bounce));
  }

  async query(query: FactsQuery, timeoutMs: number): Promise<Record<string, unknown>[]> {
    const { statement } = compileQuery(semanticRegistry(), query);
    try {
      return await runInTransaction(this.db, async (tx) => {
        await tx.execute(sql`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`);
        return [...(await tx.execute<Record<string, unknown>>(statement))];
      });
    } catch (error) {
      // 57014: query_canceled (the statement timeout).
      if ((error as { code?: string }).code === '57014') throw new AnalyticsQueryTooHeavyError();
      throw error;
    }
  }

  async oldestPendingEvent(): Promise<Date | null> {
    const [row] = await getExecutor(this.db).execute<{ at: string | null }>(
      sql`SELECT min(occurred_at)::text AS at FROM outbox_events WHERE dispatched_at IS NULL`,
    );
    return row?.at ? new Date(row.at) : null;
  }

  async labels(organizationId: string, dimension: string, values: readonly string[], locale: 'en' | 'fr') {
    const build = LABELS[dimension];
    if (!build || values.length === 0) return {};
    const rows = await getExecutor(this.db).execute<{ value: string; label: string | null }>(
      build(organizationId, [...values], locale),
    );
    return Object.fromEntries(rows.filter((row) => row.label).map((row) => [row.value, row.label as string]));
  }
}
