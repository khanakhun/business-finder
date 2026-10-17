import { type SQL, sql } from 'drizzle-orm';
import type { SemanticRegistry } from '../semantic/registry.ts';

// The semantic layer's compiler (BF-058, Interpreter): a validated query → one parameterized statement over the
// facts. Metric and dimension SQL comes from the registry (ours); everything from the request — the workspace, the
// range, the time zone, filter values, the limit — is a bound parameter. Rates are computed from their numerator
// and denominator columns after the query, so a row also carries its sample size.

export interface CompiledQuery {
  readonly statement: SQL;
  /** Output columns: `d0…` for dimensions, `m_<metric>` for base metrics. */
  readonly dimensionColumns: readonly string[];
  readonly baseMetrics: readonly string[];
}

export interface CompileInput {
  readonly organizationId: string;
  readonly metrics: readonly string[];
  readonly dimensions: readonly string[];
  readonly filters: Readonly<Record<string, readonly string[]>>;
  readonly from: Date;
  readonly to: Date;
  readonly timeZone: string;
  /** Rows fetched (the caller asks one more than it shows, to know when it truncates). */
  readonly limit: number;
}

/** A registry expression with its `{{tz}}` placeholders bound to the query's time zone. */
function expression(text: string, timeZone: string): SQL {
  const parts = text.split('{{tz}}');
  const chunks: SQL[] = [];
  parts.forEach((part, i) => {
    chunks.push(sql.raw(part));
    if (i < parts.length - 1) chunks.push(sql`${timeZone}::text`);
  });
  return sql.join(chunks, sql.raw(''));
}

/** The base metrics a query needs: its plain metrics and the parts of its rates. */
export function baseMetricsOf(registry: SemanticRegistry, metrics: readonly string[]): string[] {
  const base = new Set<string>();
  for (const id of metrics) {
    const metric = registry.metrics.get(id);
    if (!metric) throw new Error(`Unknown metric ${id}`);
    if (metric.sql) base.add(id);
    else {
      if (metric.numerator) base.add(metric.numerator);
      if (metric.denominator) base.add(metric.denominator);
    }
  }
  return [...base];
}

export function compileQuery(registry: SemanticRegistry, input: CompileInput): CompiledQuery {
  const dimension = (id: string) => {
    const spec = registry.dimensions.get(id);
    if (!spec) throw new Error(`Unknown dimension ${id}`);
    return expression(spec.sql, input.timeZone);
  };
  const baseMetrics = baseMetricsOf(registry, input.metrics);
  const dimensionColumns = input.dimensions.map((_, i) => `d${i}`);
  const select = [
    ...input.dimensions.map((id, i) => sql`${dimension(id)} AS ${sql.identifier(`d${i}`)}`),
    ...baseMetrics.map((id) => {
      const metric = registry.metrics.get(id);
      return sql`${sql.raw(metric?.sql ?? 'NULL')} AS ${sql.identifier(`m_${id}`)}`;
    }),
  ];
  const where = [
    sql`f.organization_id = ${input.organizationId}::uuid`,
    sql`f.occurred_at >= ${input.from.toISOString()}::timestamptz`,
    sql`f.occurred_at < ${input.to.toISOString()}::timestamptz`,
    ...Object.entries(input.filters).map(
      ([id, values]) =>
        sql`${dimension(id)} IN (${sql.join(
          values.map((value) => sql`${value}::text`),
          sql`, `,
        )})`,
    ),
  ];
  const groupBy = dimensionColumns.length
    ? sql` GROUP BY ${sql.join(
        dimensionColumns.map((_, i) => sql.raw(String(i + 1))),
        sql`, `,
      )} ORDER BY ${sql.join(
        dimensionColumns.map((_, i) => sql.raw(`${i + 1} NULLS LAST`)),
        sql`, `,
      )}`
    : sql``;
  const statement = sql`SELECT ${sql.join(select, sql`, `)} FROM analytics_facts f WHERE ${sql.join(
    where,
    sql` AND `,
  )}${groupBy} LIMIT ${input.limit}`;
  return { statement, dimensionColumns, baseMetrics };
}
