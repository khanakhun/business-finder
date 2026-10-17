import type { DockerApi } from './docker-engine.ts';

// The sandbox janitor (BF-043): containers a worker left behind (it crashed or was killed mid-run) are removed once
// they are older than their wall time plus a margin. Their attempts are the reaper's: no heartbeat → failed over.

export const JANITOR_MARGIN_MS = 5 * 60_000;
const DEFAULT_WALL_TIME_SEC = 3600;

export class SandboxJanitor {
  constructor(
    private readonly api: Pick<DockerApi, 'listContainers' | 'kill' | 'remove'>,
    private readonly marginMs = JANITOR_MARGIN_MS,
  ) {}

  /** Removes stale sandboxes; returns how many. */
  async sweep(now: Date): Promise<number> {
    let removed = 0;
    for (const container of await this.api.listContainers(['bf.sandbox=true'])) {
      const wallTimeSec = Number(container.labels['bf.wall_time_sec'] ?? DEFAULT_WALL_TIME_SEC);
      const limit =
        (Number.isFinite(wallTimeSec) ? wallTimeSec : DEFAULT_WALL_TIME_SEC) * 1000 + this.marginMs;
      if (now.getTime() - container.created.getTime() <= limit) continue;
      await this.api.kill(container.id, 'SIGKILL').catch(() => {});
      await this.api.remove(container.id);
      removed++;
    }
    return removed;
  }
}
