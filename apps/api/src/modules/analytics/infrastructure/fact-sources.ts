import type { AnalyticsFactType } from '@bf/contracts';
import { type SQL, sql } from 'drizzle-orm';

// Where each fact comes from (BF-058). One SELECT per fact type reads the source rows (a sent message, a finished
// job, a lead…); live ingestion runs it for the one row an event names, the backfill for everything since a date —
// the same SQL, so both write the same facts under the same `source_key`. Events without a source row (a pipeline
// move, a bounce, an unsubscribe, a score) build their row from the event payload. The insert adds the business's
// dimensions as they are at ingestion (`analytics_business_dims`) and skips keys already written.

/** The columns every source yields, in order, with their SQL types (missing ones are typed NULLs). */
const COLUMNS = [
  ['organization_id', 'uuid'],
  ['occurred_at', 'timestamptz'],
  ['event_type', 'text'],
  ['source_key', 'text'],
  ['business_id', 'uuid'],
  ['site_id', 'uuid'],
  ['job_id', 'uuid'],
  ['message_id', 'uuid'],
  ['enrollment_id', 'uuid'],
  ['lead_id', 'uuid'],
  ['area_override', 'uuid'],
  ['offer', 'text'],
  ['score_tier', 'text'],
  ['score_value', 'smallint'],
  ['profile_version', 'integer'],
  ['engine', 'text'],
  ['template_id', 'uuid'],
  ['template_version', 'integer'],
  ['variant_id', 'text'],
  ['mailbox_id', 'uuid'],
  ['locale', 'text'],
  ['creator_id', 'uuid'],
  ['outcome', 'text'],
  ['dims', 'jsonb'],
  ['cost_usd', 'numeric'],
  ['duration_ms', 'integer'],
  ['quality_score', 'double precision'],
  ['count', 'integer'],
] as const;
type Column = (typeof COLUMNS)[number][0];

const select = (values: Partial<Record<Column, SQL>>, rest: SQL = sql``): SQL =>
  sql`SELECT ${sql.join(
    COLUMNS.map(([name, type]) => {
      const value = values[name];
      return value
        ? sql`(${value})::${sql.raw(type)} AS ${sql.raw(name)}`
        : sql.raw(`NULL::${type} AS ${name}`);
    }),
    sql`, `,
  )} ${rest}`;

/** Which source rows: one (by id), or all since a date (optionally one workspace). */
export interface Scope {
  readonly organizationId?: string | undefined;
  readonly id?: string | undefined;
  readonly since?: Date | undefined;
}

const where = (scope: Scope, columns: { org: SQL; id: SQL; at: SQL }, base: SQL[] = []): SQL => {
  const conditions = [...base];
  if (scope.organizationId) conditions.push(sql`${columns.org} = ${scope.organizationId}::uuid`);
  if (scope.id) conditions.push(sql`${columns.id} = ${scope.id}::uuid`);
  if (scope.since) conditions.push(sql`${columns.at} >= ${scope.since.toISOString()}::timestamptz`);
  return conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
};

/** The engine of the business's latest generated site (for emails `m`: which engine's preview it links to). */
const LATEST_ENGINE = sql`(SELECT j.engine_current FROM generation_jobs j
  WHERE j.organization_id = m.organization_id AND j.business_id = m.business_id
    AND j.status IN ('succeeded', 'needs_review')
  ORDER BY j.finished_at DESC NULLS LAST LIMIT 1)`;

const ms = (to: SQL, from: SQL) => sql`(extract(epoch FROM (${to} - ${from})) * 1000)::int`;

export const SOURCES = {
  businessTracked: (scope: Scope) =>
    select(
      {
        organization_id: sql`ob.organization_id`,
        occurred_at: sql`ob.created_at`,
        event_type: sql`'business_tracked'`,
        source_key: sql`'business_tracked:' || ob.business_id`,
        business_id: sql`ob.business_id`,
        outcome: sql`ob.added_via`,
      },
      sql`FROM org_businesses ob ${where(scope, { org: sql`ob.organization_id`, id: sql`ob.business_id`, at: sql`ob.created_at` })}`,
    ),

  generationFinished: (scope: Scope) =>
    select(
      {
        organization_id: sql`j.organization_id`,
        occurred_at: sql`coalesce(j.finished_at, j.updated_at)`,
        event_type: sql`'generation_finished'`,
        source_key: sql`'generation_finished:' || j.id || ':' || j.status`,
        business_id: sql`j.business_id`,
        site_id: sql`j.site_id`,
        job_id: sql`j.id`,
        engine: sql`j.engine_current`,
        creator_id: sql`gb.created_by`,
        outcome: sql`j.status`,
        cost_usd: sql`j.cost_usd`,
        duration_ms: ms(
          sql`coalesce(j.finished_at, j.updated_at)`,
          sql`coalesce(j.started_at, j.created_at)`,
        ),
        quality_score: sql`j.quality_score`,
      },
      sql`FROM generation_jobs j JOIN generation_batches gb ON gb.id = j.batch_id ${where(
        scope,
        { org: sql`j.organization_id`, id: sql`j.id`, at: sql`coalesce(j.finished_at, j.updated_at)` },
        [sql`j.status IN ('succeeded', 'needs_review', 'failed', 'cancelled')`],
      )}`,
    ),

  /** A site's first preview publication (one fact per site). */
  previewPublished: (scope: Scope) =>
    select(
      {
        organization_id: sql`p.organization_id`,
        occurred_at: sql`p.published_at`,
        event_type: sql`'preview_published'`,
        source_key: sql`'preview_published:' || p.site_id`,
        business_id: sql`p.business_id`,
        site_id: sql`p.site_id`,
        creator_id: sql`p.published_by`,
      },
      sql`FROM (
        SELECT DISTINCT ON (pp.site_id) pp.site_id, pp.published_at, pp.published_by, s.organization_id, s.business_id
        FROM site_publications pp JOIN sites s ON s.id = pp.site_id
        ${where(scope, { org: sql`s.organization_id`, id: sql`pp.id`, at: sql`pp.published_at` }, [sql`pp.environment = 'preview'`])}
        ORDER BY pp.site_id, pp.published_at
      ) p`,
    ),

  /** Daily view counts, for days no hourly fact covers (the backfill; live views come from `site.viewed`). */
  siteViewsDaily: (scope: Scope) =>
    select(
      {
        organization_id: sql`s.organization_id`,
        occurred_at: sql`v.day::timestamp AT TIME ZONE 'UTC'`,
        event_type: sql`'site_viewed'`,
        source_key: sql`'site_viewed:' || v.site_id || ':' || v.day`,
        business_id: sql`s.business_id`,
        site_id: sql`v.site_id`,
        dims: sql`jsonb_build_object('unique', v.unique_estimate)`,
        count: sql`v.page_views`,
      },
      sql`FROM site_view_daily v JOIN sites s ON s.id = v.site_id ${where(
        scope,
        { org: sql`s.organization_id`, id: sql`v.site_id`, at: sql`(v.day::timestamp AT TIME ZONE 'UTC')` },
        [
          sql`v.page_views > 0`,
          sql`NOT EXISTS (SELECT 1 FROM analytics_facts x WHERE x.organization_id = s.organization_id
            AND x.event_type = 'site_viewed' AND x.site_id = v.site_id
            AND x.occurred_at >= (v.day::timestamp AT TIME ZONE 'UTC')
            AND x.occurred_at < (v.day::timestamp AT TIME ZONE 'UTC') + interval '1 day')`,
        ],
      )}`,
    ),

  leadCaptured: (scope: Scope) =>
    select(
      {
        organization_id: sql`l.organization_id`,
        occurred_at: sql`l.created_at`,
        event_type: sql`'lead_captured'`,
        source_key: sql`'lead_captured:' || l.id`,
        business_id: sql`l.business_id`,
        site_id: sql`l.site_id`,
        lead_id: sql`l.id`,
        outcome: sql`l.kind`,
      },
      sql`FROM site_leads l ${where(
        scope,
        { org: sql`l.organization_id`, id: sql`l.id`, at: sql`l.created_at` },
        [sql`l.kind IN ('claim_interest', 'contact_request')`, sql`l.status <> 'spam'`],
      )}`,
    ),

  emailSent: (scope: Scope) =>
    select(
      {
        organization_id: sql`m.organization_id`,
        occurred_at: sql`m.sent_at`,
        event_type: sql`'email_sent'`,
        source_key: sql`'email_sent:' || m.id`,
        business_id: sql`m.business_id`,
        message_id: sql`m.id`,
        enrollment_id: sql`m.sequence_enrollment_id`,
        offer: sql`m.offer`,
        template_id: sql`d.template_id`,
        template_version: sql`d.template_version`,
        variant_id: sql`(SELECT e.variant_id FROM enrollment_events e
          WHERE e.message_id = m.id AND e.variant_id IS NOT NULL LIMIT 1)`,
        engine: LATEST_ENGINE,
        mailbox_id: sql`m.mailbox_id`,
        locale: sql`m.locale`,
        creator_id: sql`coalesce(m.approved_by, m.created_by)`,
        outcome: sql`m.purpose`,
      },
      sql`FROM outbound_messages m LEFT JOIN email_drafts d ON d.id = m.draft_id ${where(
        scope,
        { org: sql`m.organization_id`, id: sql`m.id`, at: sql`m.sent_at` },
        [sql`m.sent_at IS NOT NULL`],
      )}`,
    ),

  /** A bounce of a sent message (live: the event says when and whether it is permanent). */
  emailBounced: (scope: Scope, bounce: { at: Date; permanent: boolean }) =>
    select(
      {
        organization_id: sql`m.organization_id`,
        occurred_at: sql`${bounce.at.toISOString()}::timestamptz`,
        event_type: sql`'email_bounced'`,
        source_key: sql`'email_bounced:' || m.id`,
        business_id: sql`m.business_id`,
        message_id: sql`m.id`,
        offer: sql`m.offer`,
        mailbox_id: sql`m.mailbox_id`,
        locale: sql`m.locale`,
        outcome: sql`${bounce.permanent ? 'hard' : 'soft'}::text`,
      },
      sql`FROM outbound_messages m ${where(scope, { org: sql`m.organization_id`, id: sql`m.id`, at: sql`m.sent_at` })}`,
    ),

  replyTriaged: (scope: Scope) =>
    select(
      {
        organization_id: sql`i.organization_id`,
        occurred_at: sql`i.received_at`,
        event_type: sql`'reply_triaged'`,
        source_key: sql`'reply_triaged:' || i.id`,
        business_id: sql`t.business_id`,
        message_id: sql`i.outbound_message_id`,
        enrollment_id: sql`m.sequence_enrollment_id`,
        // What the reply answers: the email's offer, template, variant and the engine of its preview.
        offer: sql`m.offer`,
        template_id: sql`d.template_id`,
        template_version: sql`d.template_version`,
        variant_id: sql`(SELECT e.variant_id FROM enrollment_events e
          WHERE e.message_id = m.id AND e.variant_id IS NOT NULL LIMIT 1)`,
        engine: LATEST_ENGINE,
        mailbox_id: sql`i.mailbox_id`,
        locale: sql`m.locale`,
        outcome: sql`coalesce(i.corrected_class, i.triage ->> 'class')`,
      },
      sql`FROM inbound_messages i JOIN email_threads t ON t.id = i.thread_id
        LEFT JOIN outbound_messages m ON m.id = i.outbound_message_id
        LEFT JOIN email_drafts d ON d.id = m.draft_id ${where(
          scope,
          { org: sql`i.organization_id`, id: sql`i.id`, at: sql`i.received_at` },
          [sql`(i.triage IS NOT NULL OR i.corrected_class IS NOT NULL)`, sql`t.business_id IS NOT NULL`],
        )}`,
    ),

  /** Pipeline moves recorded on the timeline (the backfill; live moves come from the event, same key). */
  pipelineFromActivities: (scope: Scope) =>
    select(
      {
        organization_id: sql`a.organization_id`,
        occurred_at: sql`a.occurred_at`,
        event_type: sql`'pipeline_changed'`,
        source_key: sql`'pipeline_changed:' || coalesce(a.source_event_id, a.id)`,
        business_id: sql`a.business_id`,
        outcome: sql`a.data ->> 'to'`,
        dims: sql`jsonb_build_object('from', a.data ->> 'from', 'automatic', a.data -> 'automatic')`,
      },
      sql`FROM activities a ${where(
        scope,
        { org: sql`a.organization_id`, id: sql`a.id`, at: sql`a.occurred_at` },
        [sql`a.type = 'status.changed'`],
      )}`,
    ),

  manualContact: (scope: Scope) =>
    select(
      {
        organization_id: sql`ml.organization_id`,
        occurred_at: sql`ml.created_at`,
        event_type: sql`'manual_contact'`,
        source_key: sql`'manual_contact:' || ml.id`,
        business_id: sql`ml.business_id`,
        creator_id: sql`ml.created_by`,
        outcome: sql`ml.channel`,
        duration_ms: sql`ml.duration_sec * 1000`,
        dims: sql`jsonb_build_object('result', ml.outcome)`,
      },
      sql`FROM manual_contact_logs ml ${where(scope, { org: sql`ml.organization_id`, id: sql`ml.id`, at: sql`ml.created_at` })}`,
    ),

  discoveryFinished: (scope: Scope) =>
    select(
      {
        organization_id: sql`r.organization_id`,
        occurred_at: sql`r.finished_at`,
        event_type: sql`'discovery_finished'`,
        source_key: sql`'discovery_finished:' || r.id`,
        area_override: sql`r.area_id`,
        creator_id: sql`r.created_by`,
        outcome: sql`r.status`,
        duration_ms: ms(sql`r.finished_at`, sql`coalesce(r.started_at, r.created_at)`),
        dims: sql`jsonb_build_object('costUsd', r.cost_usd)`,
      },
      sql`FROM discovery_runs r ${where(
        scope,
        { org: sql`r.organization_id`, id: sql`r.id`, at: sql`r.finished_at` },
        [sql`r.finished_at IS NOT NULL`, sql`r.organization_id IS NOT NULL`],
      )}`,
    ),

  /** Model calls with a cost (one fact per call). */
  llmCosts: (scope: Scope) =>
    select(
      {
        organization_id: sql`c.organization_id`,
        occurred_at: sql`c.created_at`,
        event_type: sql`'cost'`,
        source_key: sql`'cost:llm:' || c.id`,
        outcome: sql`'llm'`,
        dims: sql`jsonb_build_object('feature', c.task, 'model', c.model)`,
        cost_usd: sql`c.cost_usd`,
        duration_ms: sql`c.latency_ms`,
      },
      sql`FROM llm_calls c ${where(
        scope,
        { org: sql`c.organization_id`, id: sql`c.id`, at: sql`c.created_at` },
        [sql`c.organization_id IS NOT NULL`, sql`coalesce(c.cost_usd, 0) > 0`],
      )}`,
    ),

  /** Data provider spend per closed day (today's counters still move). */
  providerCosts: (scope: Scope) =>
    select(
      {
        organization_id: sql`u.organization_id`,
        occurred_at: sql`u.day::timestamp AT TIME ZONE 'UTC'`,
        event_type: sql`'cost'`,
        source_key: sql`'cost:provider:' || u.provider || ':' || u.sku || ':' || u.billing_scope || ':' || u.day`,
        outcome: sql`'providers'`,
        dims: sql`jsonb_build_object('feature', u.provider, 'sku', u.sku, 'calls', u.calls)`,
        cost_usd: sql`u.cost_usd`,
      },
      sql`FROM provider_usage u ${where(
        scope,
        { org: sql`u.organization_id`, id: sql`NULL`, at: sql`(u.day::timestamp AT TIME ZONE 'UTC')` },
        [
          sql`u.organization_id IS NOT NULL`,
          sql`u.cost_usd > 0`,
          sql`u.day < (now() AT TIME ZONE 'UTC')::date`,
        ],
      )}`,
    ),

  /** A fact built from an event payload (no source row to read). */
  fromPayload: (values: {
    organizationId: string;
    occurredAt: Date;
    eventType: AnalyticsFactType;
    sourceKey: string;
    businessId?: string | null;
    siteId?: string | null;
    messageId?: string | null;
    offer?: string | null;
    scoreTier?: string | null;
    scoreValue?: number | null;
    profileVersion?: number | null;
    outcome?: string | null;
    dims?: Record<string, unknown>;
    count?: number;
  }) =>
    select({
      organization_id: sql`${values.organizationId}`,
      occurred_at: sql`${values.occurredAt.toISOString()}`,
      event_type: sql`${values.eventType}`,
      source_key: sql`${values.sourceKey}`,
      ...(values.businessId ? { business_id: sql`${values.businessId}` } : {}),
      ...(values.siteId ? { site_id: sql`${values.siteId}` } : {}),
      ...(values.messageId ? { message_id: sql`${values.messageId}` } : {}),
      ...(values.offer ? { offer: sql`${values.offer}` } : {}),
      ...(values.scoreTier ? { score_tier: sql`${values.scoreTier}` } : {}),
      ...(values.scoreValue != null ? { score_value: sql`${values.scoreValue}` } : {}),
      ...(values.profileVersion != null ? { profile_version: sql`${values.profileVersion}` } : {}),
      ...(values.outcome ? { outcome: sql`${values.outcome}` } : {}),
      dims: sql`${JSON.stringify(values.dims ?? {})}`,
      count: sql`${values.count ?? 1}`,
    }),
} as const;

/** Inserts a source's rows as facts: the business's dimensions at ingestion, keys already written skipped. */
export function insertFacts(source: SQL): SQL {
  return sql`INSERT INTO analytics_facts (
      id, organization_id, occurred_at, event_type, source_key, business_id, site_id, job_id, message_id,
      enrollment_id, lead_id, category_path, area_id, country, offer, score_tier, score_value, profile_version,
      engine, template_id, template_version, variant_id, mailbox_id, locale, creator_id, outcome, dims, cost_usd,
      duration_ms, quality_score, count)
    SELECT bf_uuid7(), s.organization_id, s.occurred_at, s.event_type, s.source_key, s.business_id, s.site_id,
      s.job_id, s.message_id, s.enrollment_id, s.lead_id, d.category_path, coalesce(s.area_override, d.area_id),
      d.country, s.offer, coalesce(s.score_tier, d.score_tier), coalesce(s.score_value, d.score_value),
      s.profile_version, s.engine, s.template_id, s.template_version, s.variant_id, s.mailbox_id, s.locale,
      s.creator_id, s.outcome, coalesce(s.dims, '{}'::jsonb), s.cost_usd, s.duration_ms, s.quality_score,
      coalesce(s.count, 1)
    FROM (${source}) s
    LEFT JOIN LATERAL analytics_business_dims(s.organization_id, s.business_id) d ON true
    WHERE s.organization_id IS NOT NULL AND s.occurred_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM analytics_facts x
        WHERE x.organization_id = s.organization_id AND x.source_key = s.source_key)
    ON CONFLICT DO NOTHING`;
}
