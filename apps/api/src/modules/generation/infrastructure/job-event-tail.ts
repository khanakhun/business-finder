import type { EngineEvent, GenerationJobStatus } from '@bf/contracts';
import type { Redis } from 'ioredis';

// Tails a job's Valkey stream (`gen:job:<id>`) for its SSE clients (BF-039): engine events with their sequence and
// status changes, read with a blocking XREAD on a connection of its own (one per client, closed on stop).

export type TailEntry =
  | { readonly kind: 'event'; readonly seq: number; readonly event: EngineEvent }
  | { readonly kind: 'status'; readonly status: GenerationJobStatus };

export class JobEventTail {
  constructor(private readonly valkey: Pick<Redis, 'duplicate'>) {}

  /** Calls `push` for each new entry from now on; returns the stop function. */
  async follow(jobId: string, push: (entry: TailEntry) => void): Promise<() => void> {
    const connection = this.valkey.duplicate();
    let stopped = false;
    const key = `gen:job:${jobId}`;
    let last = '$';
    const loop = async () => {
      while (!stopped) {
        try {
          const result = (await connection.xread('COUNT', 100, 'BLOCK', 5_000, 'STREAMS', key, last)) as
            | [string, [string, string[]][]][]
            | null;
          for (const [, entries] of result ?? []) {
            for (const [id, fields] of entries) {
              last = id;
              const map = new Map<string, string>();
              for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i] ?? '', fields[i + 1] ?? '');
              const status = map.get('status');
              if (status) push({ kind: 'status', status: status as GenerationJobStatus });
              const event = map.get('event');
              if (event)
                push({
                  kind: 'event',
                  seq: Number(map.get('seq') ?? '0'),
                  event: JSON.parse(event) as EngineEvent,
                });
            }
          }
        } catch {
          if (stopped) return;
          // A dropped connection: try again shortly (the client may also reconnect with Last-Event-ID).
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    };
    void loop();
    return () => {
      stopped = true;
      connection.disconnect();
    };
  }
}
