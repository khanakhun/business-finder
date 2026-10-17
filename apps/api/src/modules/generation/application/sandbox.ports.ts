import type { RunnerFrame, RunnerInput } from '@bf/contracts/runner';
import type { SandboxErrorCode, SandboxRunSpec } from '@bf/contracts/sandbox';

// Sandboxes (BF-043): where agent CLIs run. A provider takes a run's spec, its input and its workspace bundle, and
// yields the runner protocol's frames; infrastructure failures are typed errors the failover policy reads.

export const SANDBOX_PROVIDER = Symbol('SandboxProvider');

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export interface SandboxProvider {
  readonly id: 'docker' | (string & {});
  /** Frames as they come; ends after the `exit` frame (or throws a `SandboxError`). Aborting stops the run. */
  run(
    spec: SandboxRunSpec,
    input: RunnerInput,
    bundle: Uint8Array,
    signal: AbortSignal,
  ): AsyncIterable<RunnerFrame>;
  /** Whether runs can start (the image is present, the daemon answers). */
  ready(image: string): Promise<{ readonly ready: boolean; readonly reason?: string }>;
}

export interface SandboxTelemetry {
  started(): void;
  finished(outcome: 'completed' | 'failed' | 'aborted' | SandboxErrorCode, seconds: number): void;
  frameError(): void;
}
