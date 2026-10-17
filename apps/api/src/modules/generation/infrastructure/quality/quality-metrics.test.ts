import type { QualityReport } from '@bf/contracts';
import { metricsHandler } from '@bf/observability';
import { describe, expect, it } from 'vitest';
import { PROMETHEUS_QUALITY_TELEMETRY } from '../metrics.ts';

// The quality pipeline's metrics (BF-045): gate outcomes per engine, decisions, scores, AI cost and platform issues
// (the series the platform-regression alert watches).

const report: QualityReport = {
  pipelineVersion: 1,
  candidateHash: 'b'.repeat(64),
  score: 62,
  decision: 'needs_review',
  infraError: false,
  gates: [
    { id: 'schema', status: 'pass', durationMs: 1, costUsd: 0, issues: [] },
    { id: 'claims', status: 'pass', durationMs: 1, costUsd: 0.004, issues: [] },
    {
      id: 'performance',
      status: 'fail',
      score: 61,
      durationMs: 1,
      costUsd: 0,
      issues: [
        {
          gate: 'performance',
          code: 'lighthouse.performance',
          severity: 'error',
          message: 'x',
          repairable: false,
          autoFixable: false,
          platform: true,
        },
      ],
    },
  ],
  autoFixes: [],
  issues: [],
  screenshots: [],
  createdAt: '2026-10-17T08:00:00.000Z',
};

describe('quality metrics', () => {
  it('counts gate outcomes, decisions, cost and platform issues, and observes scores', async () => {
    PROMETHEUS_QUALITY_TELEMETRY.evaluated('blocks', report);
    const { body } = await metricsHandler();
    expect(body).toMatch(
      /bf_generation_quality_gates_total\{engine="blocks",gate="performance",status="fail"\} 1/,
    );
    expect(body).toMatch(
      /bf_generation_quality_decisions_total\{engine="blocks",decision="needs_review"\} 1/,
    );
    expect(body).toMatch(/bf_generation_quality_cost_usd_total\{gate="claims"\} 0\.004/);
    expect(body).toMatch(/bf_generation_quality_platform_issues_total\{gate="performance"\} 1/);
    expect(body).toMatch(/bf_generation_quality_score_count\{engine="blocks"\} 1/);
  });
});
