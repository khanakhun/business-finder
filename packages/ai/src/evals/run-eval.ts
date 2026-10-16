import type { AiGateway } from '../gateway.ts';
import type { EvalConfig } from './define-eval.ts';
import type { EvalRow } from './scorers.ts';

export interface RowResult {
  readonly id: string;
  readonly tags: readonly string[];
  readonly scores: Record<string, number>;
  readonly output?: unknown;
  readonly error?: string;
  readonly latencyMs: number;
  readonly costUsd: number | null;
}

export interface EvalReport {
  readonly task: string;
  readonly model: string;
  readonly mode: string;
  readonly startedAt: string;
  readonly rows: readonly RowResult[];
  /** Mean per scorer over the rows it applies to (a failed row scores 0; no applicable row → 1, no rows → 0). */
  readonly means: Record<string, number>;
  readonly thresholds: Readonly<Record<string, number>>;
  readonly maxThresholds: Readonly<Record<string, number>>;
  readonly failures: readonly string[];
  readonly passed: boolean;
  readonly totalCostUsd: number;
}

/** No rows at all scores 0 (nothing was shown); rows the scorer never applied to score 1 (nothing to judge). */
const meanOf = (values: readonly number[], rowCount: number) => {
  if (rowCount === 0) return 0;
  return values.length === 0 ? 1 : values.reduce((sum, v) => sum + v, 0) / values.length;
};

/** Runs every row through the gateway, scores it, and compares the means with the thresholds. */
export async function runEval(
  config: EvalConfig,
  rows: readonly EvalRow[],
  options: {
    readonly gateway: AiGateway;
    readonly model: string;
    readonly mode: string;
    readonly concurrency?: number;
    readonly now?: () => Date;
  },
): Promise<EvalReport> {
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const results: RowResult[] = new Array(rows.length);
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const index = next++;
      const row = rows[index] as EvalRow;
      const started = performance.now();
      try {
        const result =
          config.task.kind === 'vision'
            ? await options.gateway.vision(
                config.task,
                {
                  input: (row.input as { input: unknown }).input as never,
                  images: config.images ? await config.images(row) : [],
                },
                { orgId: null },
              )
            : await options.gateway.run(config.task, row.input as never, { orgId: null });
        const scores: Record<string, number> = {};
        for (const scorer of config.scorers) {
          const value = await scorer.score(result.output, row, {
            gateway: options.gateway,
            orgId: null,
          });
          if (value !== null) scores[scorer.name] = value;
        }
        results[index] = {
          id: row.id,
          tags: row.tags ?? [],
          scores,
          output: result.output,
          latencyMs: Math.round(performance.now() - started),
          costUsd: result.costUsd,
        };
      } catch (error) {
        results[index] = {
          id: row.id,
          tags: row.tags ?? [],
          scores: Object.fromEntries(config.scorers.map((s) => [s.name, 0])),
          error: error instanceof Error ? error.message : String(error),
          latencyMs: Math.round(performance.now() - started),
          costUsd: null,
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, rows.length) }, worker));
  const means = Object.fromEntries(
    config.scorers.map((s) => [
      s.name,
      meanOf(
        results.flatMap((r) => (s.name in r.scores ? [r.scores[s.name] as number] : [])),
        results.length,
      ),
    ]),
  );
  for (const aggregate of config.aggregates ?? []) {
    means[aggregate.name] =
      results.length === 0
        ? 0
        : aggregate.score(rows.map((row, index) => ({ row, output: results[index]?.output })));
  }
  const maxThresholds = config.maxThresholds ?? {};
  const failures = [
    ...Object.entries(config.thresholds)
      .filter(([name, min]) => (means[name] ?? 0) < min)
      .map(([name, min]) => `${name}: ${(means[name] ?? 0).toFixed(3)} < ${min}`),
    ...Object.entries(maxThresholds)
      .filter(([name, max]) => !((means[name] ?? Number.POSITIVE_INFINITY) <= max))
      .map(([name, max]) => `${name}: ${(means[name] ?? Number.NaN).toFixed(3)} > ${max}`),
  ];
  return {
    task: config.task.name,
    model: options.model,
    mode: options.mode,
    startedAt,
    rows: results,
    means,
    thresholds: config.thresholds,
    maxThresholds,
    failures,
    passed: failures.length === 0 && results.length > 0,
    totalCostUsd: results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
  };
}

export function reportMarkdown(report: EvalReport): string {
  const lines = [
    `# Eval — ${report.task}`,
    '',
    `- Model: \`${report.model}\` (${report.mode}) · started ${report.startedAt}`,
    `- Rows: ${report.rows.length} · errors: ${report.rows.filter((r) => r.error).length} · cost: $${report.totalCostUsd.toFixed(4)}`,
    `- Result: **${report.passed ? 'PASS' : 'FAIL'}**`,
    '',
    '| Scorer | Mean | Threshold |',
    '|---|---|---|',
    ...Object.entries(report.means).map(
      ([name, mean]) =>
        `| ${name} | ${mean.toFixed(3)} | ${
          report.thresholds[name] !== undefined
            ? `≥ ${report.thresholds[name]}`
            : report.maxThresholds[name] !== undefined
              ? `≤ ${report.maxThresholds[name]}`
              : '—'
        } |`,
    ),
  ];
  const weak = report.rows.filter((r) => r.error || Object.values(r.scores).some((s) => s < 1));
  if (weak.length > 0) {
    lines.push('', '## Rows below 1', '', '| Row | Tags | Scores / error |', '|---|---|---|');
    for (const row of weak) {
      const detail =
        row.error ??
        Object.entries(row.scores)
          .filter(([, s]) => s < 1)
          .map(([n, s]) => `${n}=${s.toFixed(2)}`)
          .join(', ');
      lines.push(`| ${row.id} | ${row.tags.join(', ')} | ${detail.replace(/\|/g, '\\|')} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
