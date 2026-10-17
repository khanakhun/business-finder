import {
  type AnalyticsCohorts,
  type AnalyticsFreshness,
  type AnalyticsFunnel,
  type AnalyticsPeriodQuery,
  AnalyticsPeriodQuerySchema,
  type AnalyticsQuery,
  AnalyticsQuerySchema,
  type AnalyticsRegistry,
  type AnalyticsResult,
  type AnalyticsTrends,
  type Clock,
  FUNNEL_STEPS,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { AuditLogger, WorkspaceDefaults } from '../../workspace/index.ts';
import { queryProblems } from '../domain/query-spec.ts';
import { publicRegistry, type SemanticRegistry, semanticRegistry } from '../semantic/registry.ts';
import { FACTS_MAINTENANCE, FACTS_STORE, type FactsMaintenance, type FactsStore } from './ports.ts';
import { LLM_WATERMARK } from './refresh.ts';

// Analytics queries (BF-058): one contract for dashboards and exports. A query names registry metrics and
// dimensions (validated, never SQL); rates come back with their sample (`<metric>__n`, the denominator, and
// `<metric>__num`), dimension values with their labels, and every answer with its freshness.

const TIMEOUT_MS = 10_000;
/** Dashboards ask the same questions again: answers are kept a minute (per workspace and query). */
const CACHE_MS = 60_000;
const CACHE_SIZE = 500;

export interface AnalyticsActor {
  readonly organizationId: string;
  readonly locale: 'en' | 'fr';
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

@Injectable()
export class AnalyticsQueries {
  private readonly registry: SemanticRegistry = semanticRegistry();
  private readonly cache = new Map<string, { at: number; value: AnalyticsResult }>();

  constructor(
    @Inject(FACTS_STORE) private readonly store: FactsStore,
    @Inject(FACTS_MAINTENANCE) private readonly maintenance: FactsMaintenance,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly workspace: WorkspaceDefaults,
    private readonly audit: AuditLogger,
  ) {}

  definitions(): AnalyticsRegistry {
    return publicRegistry(this.registry);
  }

  async query(actor: AnalyticsActor, input: AnalyticsQuery): Promise<AnalyticsResult> {
    const request = AnalyticsQuerySchema.parse(input);
    const key = `${actor.organizationId}:${actor.locale}:${JSON.stringify(request)}`;
    const now = this.clock.now().getTime();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    const value = await this.answer(actor, request);
    if (this.cache.size >= CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { at: now, value });
    return value;
  }

  private async answer(
    actor: AnalyticsActor,
    request: ReturnType<typeof AnalyticsQuerySchema.parse>,
  ): Promise<AnalyticsResult> {
    const timeZone = request.timeZone ?? (await this.workspace.timeZone(actor.organizationId));
    const shape = {
      metrics: request.metrics,
      dimensions: request.dimensions,
      filters: request.filters,
      from: new Date(request.from),
      to: new Date(request.to),
      timeZone,
    };
    const problems = queryProblems(shape, {
      metrics: new Set(this.registry.metrics.keys()),
      dimensions: new Set(this.registry.dimensions.keys()),
      timeDimensions: new Set([...this.registry.dimensions.values()].filter((d) => d.time).map((d) => d.id)),
    });
    if (problems.length > 0) throw new ValidationError('This analytics query is not valid.', problems);
    const [raw, freshness] = await Promise.all([
      this.store.query(
        { ...shape, organizationId: actor.organizationId, limit: request.limit + 1 },
        TIMEOUT_MS,
      ),
      this.freshness(),
    ]);
    const truncated = raw.length > request.limit;
    const rows = raw.slice(0, request.limit).map((row) => this.row(row, request.dimensions, request.metrics));
    const labels: AnalyticsResult['labels'] = {};
    await Promise.all(
      request.dimensions.map(async (dimension) => {
        const values = [
          ...new Set(rows.map((row) => row[dimension]).filter((v): v is string => typeof v === 'string')),
        ];
        const found = await this.store.labels(actor.organizationId, dimension, values, actor.locale);
        if (Object.keys(found).length > 0) labels[dimension] = found;
      }),
    );
    return { dimensions: request.dimensions, metrics: request.metrics, rows, labels, truncated, freshness };
  }

  /** Facts are complete up to the oldest event still on its way, and costs up to the last refresh. */
  private async freshness(): Promise<AnalyticsFreshness> {
    const now = this.clock.now();
    const [pending, costs] = await Promise.all([
      this.store.oldestPendingEvent(),
      this.maintenance.watermark(LLM_WATERMARK),
    ]);
    const watermark = [pending, costs, now]
      .filter((at): at is Date => at !== null)
      .reduce((a, b) => (a < b ? a : b));
    return {
      watermark: watermark.toISOString(),
      lagSeconds: Math.round((now.getTime() - watermark.getTime()) / 1_000),
    };
  }

  /** The funnel over a period (each step a registry metric), optionally by one dimension. */
  async funnel(actor: AnalyticsActor, input: AnalyticsPeriodQuery): Promise<AnalyticsFunnel> {
    const period = AnalyticsPeriodQuerySchema.parse(input);
    const result = await this.query(actor, {
      metrics: [...FUNNEL_STEPS],
      dimensions: period.dimension ? [period.dimension] : [],
      from: period.from,
      to: period.to,
      ...(period.timeZone ? { timeZone: period.timeZone } : {}),
      limit: 200,
    });
    return {
      steps: [...FUNNEL_STEPS],
      segments: result.rows.map((row) => {
        const segment = period.dimension ? ((row[period.dimension] as string | null) ?? null) : null;
        return {
          segment,
          label: period.dimension && segment ? (result.labels[period.dimension]?.[segment] ?? null) : null,
          counts: FUNNEL_STEPS.map((step) => Number(row[step] ?? 0)),
        };
      }),
      freshness: result.freshness,
    };
  }

  /** Businesses by week of first contact, and what they did since. */
  async cohorts(actor: AnalyticsActor, input: AnalyticsPeriodQuery): Promise<AnalyticsCohorts> {
    const period = AnalyticsPeriodQuerySchema.parse(input);
    const timeZone = period.timeZone ?? (await this.workspace.timeZone(actor.organizationId));
    const [weeks, freshness] = await Promise.all([
      this.maintenance.cohorts(actor.organizationId, new Date(period.from), new Date(period.to), timeZone),
      this.freshness(),
    ]);
    return { weeks, freshness };
  }

  /** Daily totals from the rollup (the overview's trend lines). */
  async trends(actor: AnalyticsActor, input: AnalyticsPeriodQuery): Promise<AnalyticsTrends> {
    const period = AnalyticsPeriodQuerySchema.parse(input);
    const from = period.from.slice(0, 10);
    const to = period.to.slice(0, 10);
    const [rows, refreshedAt] = await Promise.all([
      this.maintenance.daily(actor.organizationId, from, to),
      this.maintenance.watermark('analytics_daily'),
    ]);
    const byDay = new Map<string, AnalyticsTrends['days'][number]>();
    for (const row of rows) {
      const day =
        byDay.get(row.day) ??
        ({
          day: row.day,
          businessesDiscovered: 0,
          emailsSent: 0,
          leads: 0,
          pageViews: 0,
          previewsPublished: 0,
          jobsFinished: 0,
          spendUsd: 0,
        } satisfies AnalyticsTrends['days'][number]);
      if (row.eventType === 'business_tracked') day.businessesDiscovered += row.facts;
      if (row.eventType === 'email_sent') day.emailsSent += row.facts;
      if (row.eventType === 'lead_captured') day.leads += row.facts;
      if (row.eventType === 'site_viewed') day.pageViews += row.units;
      if (row.eventType === 'preview_published') day.previewsPublished += row.facts;
      if (row.eventType === 'generation_finished') day.jobsFinished += row.facts;
      if (row.eventType === 'cost') day.spendUsd += row.costUsd;
      byDay.set(row.day, day);
    }
    return { days: [...byDay.values()], refreshedAt: refreshedAt?.toISOString() ?? null };
  }

  /** The query as CSV (the same numbers as the screen), audited. */
  async exportCsv(actor: AnalyticsActor, input: AnalyticsQuery): Promise<string> {
    const result = await this.query(actor, input);
    await this.audit.record({
      action: 'analytics.exported',
      organizationId: actor.organizationId,
      entityType: 'analytics',
      metadata: { metrics: result.metrics, dimensions: result.dimensions, rows: result.rows.length },
    });
    const columns = [
      ...result.dimensions.flatMap((d) => (result.labels[d] ? [d, `${d}_label`] : [d])),
      ...result.metrics.flatMap((m) => {
        const spec = this.registry.metrics.get(m);
        return spec?.sql ? [m] : [m, `${m}_numerator`, `${m}_denominator`];
      }),
    ];
    const cell = (value: unknown) => {
      if (value === null || value === undefined) return '';
      const text = String(value);
      // Formula injection: a spreadsheet must not run a cell.
      const safe = /^[=+\-@\t\r]/.test(text) && Number.isNaN(Number(text)) ? `'${text}` : text;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = result.rows.map((row) =>
      columns
        .map((column) => {
          if (column.endsWith('_label')) {
            const dimension = column.slice(0, -'_label'.length);
            return cell(result.labels[dimension]?.[String(row[dimension])]);
          }
          if (column.endsWith('_numerator'))
            return cell(row[`${column.slice(0, -'_numerator'.length)}__num`]);
          if (column.endsWith('_denominator'))
            return cell(row[`${column.slice(0, -'_denominator'.length)}__n`]);
          return cell(row[column]);
        })
        .join(','),
    );
    return `${[columns.join(','), ...lines].join('\n')}\n`;
  }

  private row(raw: Record<string, unknown>, dimensions: readonly string[], metrics: readonly string[]) {
    const row: AnalyticsResult['rows'][number] = {};
    dimensions.forEach((dimension, i) => {
      const value = raw[`d${i}`];
      row[dimension] = value === null || value === undefined ? null : String(value);
    });
    for (const id of metrics) {
      const spec = this.registry.metrics.get(id);
      if (!spec) continue;
      if (spec.sql) {
        row[id] = num(raw[`m_${id}`]);
        continue;
      }
      const numerator = num(raw[`m_${spec.numerator}`]) ?? 0;
      const denominator = num(raw[`m_${spec.denominator}`]) ?? 0;
      row[id] = denominator > 0 ? numerator / denominator : null;
      row[`${id}__num`] = numerator;
      row[`${id}__n`] = denominator;
    }
    return row;
  }
}
