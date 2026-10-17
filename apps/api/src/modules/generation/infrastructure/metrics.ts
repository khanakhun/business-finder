import type { EngineId, GenerationJobStatus } from '@bf/contracts';
import { metrics } from '@bf/observability';
import type { GenerationTelemetry, StoredJob } from '../application/ports.ts';
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
