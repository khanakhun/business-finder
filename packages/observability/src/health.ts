export type HealthStatus = 'up' | 'down';

export interface HealthCheckResult {
  readonly status: HealthStatus;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** A dependency check for `/health/ready` (database, Valkey, S3, intel …). */
export interface HealthIndicator {
  readonly name: string;
  /** A failing critical dependency makes the service `down` (not ready); others only `degraded`. Default true. */
  readonly critical?: boolean;
  check(signal: AbortSignal): Promise<HealthCheckResult>;
}

export interface HealthReport {
  readonly status: 'up' | 'degraded' | 'down';
  readonly checks: Readonly<
    Record<
      string,
      { status: HealthStatus; critical: boolean; durationMs: number; error?: string; details?: unknown }
    >
  >;
}

/** Runs all checks concurrently, each with a timeout; error messages are reported, never thrown. */
export async function aggregateHealth(
  indicators: readonly HealthIndicator[],
  options: { readonly timeoutMs?: number } = {},
): Promise<HealthReport> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const entries = await Promise.all(
    indicators.map(async (indicator) => {
      const started = performance.now();
      const critical = indicator.critical ?? true;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Reject before aborting: an abort listener that resolves must not win the race.
          reject(new Error(`timed out after ${timeoutMs} ms`));
          controller.abort();
        }, timeoutMs);
      });
      try {
        const result = await Promise.race([indicator.check(controller.signal), timeout]);
        const durationMs = Math.round(performance.now() - started);
        return [
          indicator.name,
          {
            status: result.status,
            critical,
            durationMs,
            ...(result.details ? { details: result.details } : {}),
          },
        ] as const;
      } catch (error) {
        const durationMs = Math.round(performance.now() - started);
        return [
          indicator.name,
          {
            status: 'down' as const,
            critical,
            durationMs,
            error: error instanceof Error ? error.message : String(error),
          },
        ] as const;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const checks: HealthReport['checks'] = Object.fromEntries(entries);
  const failing = Object.values(checks).filter((c) => c.status === 'down');
  const status = failing.some((c) => c.critical) ? 'down' : failing.length > 0 ? 'degraded' : 'up';
  return { status, checks };
}
