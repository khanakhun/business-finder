import { type DbClient, getExecutor, runInTransaction } from '@bf/db';
import { Inject, Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  CohortRow,
  DailyTrendRow,
  FactScope,
  FactSourceName,
  FactsMaintenance,
  FactsQuery,
  FactsStore,
  PayloadFact,
  ReconcileCount,
} from '../application/ports.ts';
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
export class DrizzleFactsStore implements FactsStore, FactsMaintenance {
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

  // ── Upkeep ────────────────────────────────────────────────────────────────────────────────────────────────

  async exclusively(name: string, work: () => Promise<void>): Promise<boolean> {
    return runInTransaction(this.db, async (tx) => {
      const [lock] = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${`analytics:${name}`})) AS locked`,
      );
      if (!lock?.locked) return false;
      await work();
      return true;
    });
  }

  async ensurePartitions(monthsAhead: number): Promise<void> {
    await getExecutor(this.db).execute(
      sql`SELECT analytics_ensure_partitions(now(), 0, ${monthsAhead}::int)`,
    );
  }

  async watermark(source: string): Promise<Date | null> {
    const [row] = await getExecutor(this.db).execute<{ at: string }>(
      sql`SELECT watermark::text AS at FROM analytics_watermarks WHERE source = ${source}`,
    );
    return row ? new Date(row.at) : null;
  }

  async setWatermark(source: string, at: Date): Promise<void> {
    await getExecutor(this.db).execute(sql`
      INSERT INTO analytics_watermarks (source, watermark, updated_at)
      VALUES (${source}, ${at.toISOString()}::timestamptz, now())
      ON CONFLICT (source) DO UPDATE SET watermark = excluded.watermark, updated_at = now()`);
  }

  async refreshDaily(since: Date): Promise<number> {
    const executor = getExecutor(this.db);
    const touched = await executor.execute<{ organization_id: string; day: string }>(sql`
      SELECT DISTINCT organization_id::text, ((occurred_at AT TIME ZONE 'UTC')::date)::text AS day
      FROM analytics_facts WHERE ingested_at >= ${since.toISOString()}::timestamptz`);
    for (const { organization_id: org, day } of touched) {
      await executor.execute(
        sql`DELETE FROM analytics_daily WHERE organization_id = ${org}::uuid AND day = ${day}::date`,
      );
      await executor.execute(sql`
        INSERT INTO analytics_daily (organization_id, day, event_type, outcome, category, score_tier, engine, offer,
          facts, units, cost_usd, duration_ms_sum, quality_sum, quality_n)
        SELECT f.organization_id, ${day}::date, f.event_type, coalesce(f.outcome, ''),
          coalesce(subpath(f.category_path, 0, 1)::text, ''), coalesce(f.score_tier, ''), coalesce(f.engine, ''),
          coalesce(f.offer, ''), count(*), sum(f.count), coalesce(sum(f.cost_usd), 0),
          coalesce(sum(f.duration_ms), 0), coalesce(sum(f.quality_score), 0), count(f.quality_score)
        FROM analytics_facts f
        WHERE f.organization_id = ${org}::uuid
          AND f.occurred_at >= (${day}::date)::timestamp AT TIME ZONE 'UTC'
          AND f.occurred_at < (${day}::date + 1)::timestamp AT TIME ZONE 'UTC'
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`);
    }
    return touched.length;
  }

  async reconcileCounts(from: Date, to: Date): Promise<ReconcileCount[]> {
    const range = { from: from.toISOString(), to: to.toISOString() };
    const rows = await getExecutor(this.db).execute<{
      organization_id: string;
      metric: ReconcileCount['metric'];
      facts: string;
      source: string;
    }>(sql`
      WITH facts AS (
        SELECT organization_id,
          CASE event_type WHEN 'email_sent' THEN 'emails_sent' WHEN 'lead_captured' THEN 'leads'
            ELSE 'jobs_finished' END AS metric,
          count(DISTINCT coalesce(job_id, message_id, lead_id)) AS n
        FROM analytics_facts
        WHERE event_type IN ('email_sent', 'lead_captured', 'generation_finished')
          AND occurred_at >= ${range.from}::timestamptz AND occurred_at < ${range.to}::timestamptz
        GROUP BY 1, 2),
      sources AS (
        SELECT organization_id, 'emails_sent' AS metric, count(*) AS n FROM outbound_messages
          WHERE sent_at >= ${range.from}::timestamptz AND sent_at < ${range.to}::timestamptz GROUP BY 1
        UNION ALL
        SELECT organization_id, 'leads', count(*) FROM site_leads
          WHERE kind IN ('claim_interest', 'contact_request') AND status <> 'spam'
            AND created_at >= ${range.from}::timestamptz AND created_at < ${range.to}::timestamptz GROUP BY 1
        UNION ALL
        SELECT organization_id, 'jobs_finished', count(*) FROM generation_jobs
          WHERE status IN ('succeeded', 'needs_review', 'failed', 'cancelled')
            AND coalesce(finished_at, updated_at) >= ${range.from}::timestamptz
            AND coalesce(finished_at, updated_at) < ${range.to}::timestamptz GROUP BY 1)
      SELECT coalesce(f.organization_id, s.organization_id)::text AS organization_id,
        coalesce(f.metric, s.metric) AS metric, coalesce(f.n, 0)::text AS facts, coalesce(s.n, 0)::text AS source
      FROM facts f FULL JOIN sources s ON s.organization_id = f.organization_id AND s.metric = f.metric`);
    return rows.map((row) => ({
      organizationId: row.organization_id,
      metric: row.metric,
      facts: Number(row.facts),
      source: Number(row.source),
    }));
  }

  async cohorts(organizationId: string, from: Date, to: Date, timeZone: string): Promise<CohortRow[]> {
    const rows = await getExecutor(this.db).execute<Record<keyof CohortRow, string>>(sql`
      WITH first AS (
        SELECT business_id, min(occurred_at) AS first_at FROM analytics_facts
        WHERE organization_id = ${organizationId}::uuid AND event_type IN ('email_sent', 'manual_contact')
          AND business_id IS NOT NULL
        GROUP BY business_id
        HAVING min(occurred_at) >= ${from.toISOString()}::timestamptz
          AND min(occurred_at) < ${to.toISOString()}::timestamptz),
      flags AS (
        SELECT fi.business_id, fi.first_at,
          bool_or(f.event_type = 'reply_triaged' AND f.outcome <> 'auto_reply') AS replied,
          bool_or(f.event_type = 'reply_triaged' AND f.outcome IN ('interested', 'question')) AS positive,
          bool_or(f.event_type = 'pipeline_changed' AND f.outcome = 'meeting') AS meeting,
          bool_or(f.event_type = 'pipeline_changed' AND f.outcome = 'won') AS won
        FROM first fi
        LEFT JOIN analytics_facts f ON f.organization_id = ${organizationId}::uuid
          AND f.business_id = fi.business_id AND f.occurred_at >= fi.first_at
          AND f.event_type IN ('reply_triaged', 'pipeline_changed')
        GROUP BY fi.business_id, fi.first_at)
      SELECT to_char(date_trunc('week', first_at AT TIME ZONE ${timeZone}::text), 'YYYY-MM-DD') AS week,
        count(*)::text AS contacted, count(*) FILTER (WHERE replied)::text AS replied,
        count(*) FILTER (WHERE positive)::text AS positive, count(*) FILTER (WHERE meeting)::text AS meetings,
        count(*) FILTER (WHERE won)::text AS won
      FROM flags GROUP BY 1 ORDER BY 1`);
    return rows.map((row) => ({
      week: row.week,
      contacted: Number(row.contacted),
      replied: Number(row.replied),
      positive: Number(row.positive),
      meetings: Number(row.meetings),
      won: Number(row.won),
    }));
  }

  async daily(organizationId: string, from: string, to: string): Promise<DailyTrendRow[]> {
    const rows = await getExecutor(this.db).execute<{
      day: string;
      event_type: string;
      facts: string;
      units: string;
      cost_usd: string;
    }>(sql`
      SELECT day::text, event_type, sum(facts)::text AS facts, sum(units)::text AS units,
        sum(cost_usd)::text AS cost_usd
      FROM analytics_daily
      WHERE organization_id = ${organizationId}::uuid AND day >= ${from}::date AND day < ${to}::date
      GROUP BY 1, 2 ORDER BY 1, 2`);
    return rows.map((row) => ({
      day: row.day,
      eventType: row.event_type,
      facts: Number(row.facts),
      units: Number(row.units),
      costUsd: Number(row.cost_usd),
    }));
  }
}
