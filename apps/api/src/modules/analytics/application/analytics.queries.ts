import {
  type AnalyticsQuery,
  AnalyticsQuerySchema,
  type AnalyticsRegistry,
  type AnalyticsResult,
  type Clock,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { AuditLogger, WorkspaceDefaults } from '../../workspace/index.ts';
import { queryProblems } from '../domain/query-spec.ts';
import { publicRegistry, type SemanticRegistry, semanticRegistry } from '../semantic/registry.ts';
import { FACTS_STORE, type FactsStore } from './ports.ts';

// Analytics queries (BF-058): one contract for dashboards and exports. A query names registry metrics and
// dimensions (validated, never SQL); rates come back with their sample (`<metric>__n`, the denominator, and
// `<metric>__num`), dimension values with their labels, and every answer with its freshness.

const TIMEOUT_MS = 10_000;

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

  constructor(
    @Inject(FACTS_STORE) private readonly store: FactsStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly workspace: WorkspaceDefaults,
    private readonly audit: AuditLogger,
  ) {}

  definitions(): AnalyticsRegistry {
    return publicRegistry(this.registry);
  }

  async query(actor: AnalyticsActor, input: AnalyticsQuery): Promise<AnalyticsResult> {
    const request = AnalyticsQuerySchema.parse(input);
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
    const [raw, pending] = await Promise.all([
      this.store.query(
        { ...shape, organizationId: actor.organizationId, limit: request.limit + 1 },
        TIMEOUT_MS,
      ),
      this.store.oldestPendingEvent(),
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
    const now = this.clock.now();
    const watermark = pending && pending < now ? pending : now;
    return {
      dimensions: request.dimensions,
      metrics: request.metrics,
      rows,
      labels,
      truncated,
      freshness: {
        watermark: watermark.toISOString(),
        lagSeconds: Math.round((now.getTime() - watermark.getTime()) / 1_000),
      },
    };
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
