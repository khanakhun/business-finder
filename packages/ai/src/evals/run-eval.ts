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
  /** Mean per scorer (a failed row scores 0). */
  readonly means: Record<string, number>;
  readonly thresholds: Readonly<Record<string, number>>;
  readonly failures: readonly string[];
  readonly passed: boolean;
  readonly totalCostUsd: number;
}

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
        const result = await options.gateway.run(config.task, row.input as never, { orgId: null });
        const scores: Record<string, number> = {};
        for (const scorer of config.scorers) {
          scores[scorer.name] = await scorer.score(result.output, row, {
            gateway: options.gateway,
            orgId: null,
          });
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
      results.reduce((sum, r) => sum + (r.scores[s.name] ?? 0), 0) / Math.max(results.length, 1),
    ]),
  );
  const failures = Object.entries(config.thresholds)
    .filter(([name, min]) => (means[name] ?? 0) < min)
    .map(([name, min]) => `${name}: ${(means[name] ?? 0).toFixed(3)} < ${min}`);
  return {
    task: config.task.name,
    model: options.model,
    mode: options.mode,
    startedAt,
    rows: results,
    means,
    thresholds: config.thresholds,
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
      ([name, mean]) => `| ${name} | ${mean.toFixed(3)} | ${report.thresholds[name]?.toString() ?? '—'} |`,
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
