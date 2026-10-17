import type { EngineId, GenerationJobStatus } from '@bf/contracts';
import { metrics } from '@bf/observability';
import type { GenerationTelemetry, QualityTelemetry, StoredJob } from '../application/ports.ts';
import type { SandboxTelemetry } from '../application/sandbox.ports.ts';

// Generation metrics (BF-039): outcomes per engine, phase durations, queue waits, cost per job, sandboxes in use and
// how often jobs waited for a slot.

export const jobsTotal = () =>
  metrics.counter({
    name: 'bf_generation_jobs_total',
    help: 'Generation jobs that settled, by engine and outcome',
    labelNames: ['engine', 'outcome'],
  });

export const phaseSeconds = () =>
  metrics.histogram({
    name: 'bf_generation_phase_seconds',
    help: 'Time spent per phase of an attempt (prepare, run)',
    labelNames: ['engine', 'phase'],
    buckets: [0.1, 0.5, 1, 5, 15, 60, 180, 600, 1800],
  });

export const queueWaitSeconds = () =>
  metrics.histogram({
    name: 'bf_generation_queue_wait_seconds',
    help: 'Time from dispatch to an attempt starting',
    labelNames: ['engine'],
    buckets: [0.1, 1, 5, 15, 60, 300, 900, 3600],
  });

/** BF-061: from creation to a terminal state (the generation SLO: 95% within 30 minutes). */
export const jobSeconds = () =>
  metrics.histogram({
    name: 'bf_generation_job_seconds',
    help: 'Time from a job being created to it settling, by engine and outcome',
    labelNames: ['engine', 'outcome'],
    buckets: [60, 300, 600, 900, 1800, 3600, 7200],
  });

export const jobCostUsd = () =>
  metrics.histogram({
    name: 'bf_generation_job_cost_usd',
    help: 'Cost of a settled job (all attempts)',
    labelNames: ['engine'],
    buckets: [0.01, 0.1, 0.5, 1, 2, 5, 10, 25],
  });

export const activeSandboxes = () =>
  metrics.gauge({ name: 'bf_generation_active_sandboxes', help: 'Sandbox leases held (all workers)' });

export const leaseWaits = () =>
  metrics.counter({
    name: 'bf_generation_lease_waits_total',
    help: 'Attempts deferred because no slot was free',
    labelNames: ['engine'],
  });

/** The orchestration's metrics on the shared registry. */
export const PROMETHEUS_TELEMETRY: GenerationTelemetry = {
  leaseWait: (engine: EngineId) => leaseWaits().inc({ engine }),
  queueWait: (engine: EngineId, seconds: number) => queueWaitSeconds().observe({ engine }, seconds),
  phase: (engine: EngineId, phase: 'prepare' | 'run', seconds: number) =>
    phaseSeconds().observe({ engine, phase }, seconds),
  sandboxes: (held: number) => activeSandboxes().set(held),
  settled: (job: StoredJob, outcome: GenerationJobStatus) => {
    jobsTotal().inc({ engine: job.engineCurrent, outcome });
    jobCostUsd().observe({ engine: job.engineCurrent }, job.costUsd);
    const end = job.finishedAt ?? new Date();
    jobSeconds().observe(
      { engine: job.engineCurrent, outcome },
      Math.max(0, (end.getTime() - job.createdAt.getTime()) / 1000),
    );
  },
};

// Sandboxes (BF-043): runs by outcome (including the typed failures, e.g. SANDBOX_OOM), their durations, and frames
// the supervisor sent that were not valid protocol.
const sandboxRuns = () =>
  metrics.counter({
    name: 'bf_sandbox_runs_total',
    help: 'Sandbox runs that ended, by outcome (completed, failed, aborted or a SANDBOX_* error)',
    labelNames: ['outcome'],
  });
const sandboxSeconds = () =>
  metrics.histogram({
    name: 'bf_sandbox_run_seconds',
    help: 'Wall time of sandbox runs, container creation to removal',
    labelNames: ['outcome'],
    buckets: [5, 15, 60, 180, 600, 1200, 2400, 3600],
  });
const sandboxFrameErrors = () =>
  metrics.counter({
    name: 'bf_sandbox_frame_errors_total',
    help: 'Lines from a sandbox that were not valid frames',
  });
const sandboxStarts = () =>
  metrics.counter({ name: 'bf_sandbox_started_total', help: 'Sandbox containers created' });

export const PROMETHEUS_SANDBOX_TELEMETRY: SandboxTelemetry = {
  started: () => sandboxStarts().inc(),
  finished: (outcome, seconds) => {
    sandboxRuns().inc({ outcome });
    sandboxSeconds().observe({ outcome }, seconds);
  },
  frameError: () => sandboxFrameErrors().inc(),
};

export const qualityGatesTotal = () =>
  metrics.counter({
    name: 'bf_generation_quality_gates_total',
    help: 'Quality gate outcomes (BF-045), by engine, gate and status (pass, fail, skipped, error)',
    labelNames: ['engine', 'gate', 'status'],
  });

export const qualityDecisionsTotal = () =>
  metrics.counter({
    name: 'bf_generation_quality_decisions_total',
    help: 'Quality decisions (pass, repair, needs_review) by engine',
    labelNames: ['engine', 'decision'],
  });

export const qualityScore = () =>
  metrics.histogram({
    name: 'bf_generation_quality_score',
    help: 'Quality score (0–100) of an evaluated version, by engine',
    labelNames: ['engine'],
    buckets: [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100],
  });

export const qualityCostUsd = () =>
  metrics.counter({
    name: 'bf_generation_quality_cost_usd_total',
    help: 'Cost of the AI quality gates (claims, visual critic)',
    labelNames: ['gate'],
  });

export const qualityPlatformIssues = () =>
  metrics.counter({
    name: 'bf_generation_quality_platform_issues_total',
    help: 'Issues the platform causes (renderer, fonts, scripts), by gate: a spike is a platform regression',
    labelNames: ['gate'],
  });

export const qualityGateScore = () =>
  metrics.histogram({
    name: 'bf_generation_quality_gate_score',
    help: 'Score of a scored gate (copy, a11y, performance: Lighthouse, visual), by gate',
    labelNames: ['gate'],
    buckets: [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100],
  });

/** The quality pipeline's metrics on the shared registry. */
export const PROMETHEUS_QUALITY_TELEMETRY: QualityTelemetry = {
  evaluated(engine, report) {
    qualityDecisionsTotal().inc({ engine, decision: report.decision });
    qualityScore().observe({ engine }, report.score);
    for (const gate of report.gates) {
      qualityGatesTotal().inc({ engine, gate: gate.id, status: gate.status });
      if (gate.score !== undefined) qualityGateScore().observe({ gate: gate.id }, gate.score);
      if (gate.costUsd > 0) qualityCostUsd().inc({ gate: gate.id }, gate.costUsd);
      const platform = gate.issues.filter((issue) => issue.platform).length;
      if (platform > 0) qualityPlatformIssues().inc({ gate: gate.id }, platform);
    }
  },
};
