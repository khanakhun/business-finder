import { RateLimitedError } from '@bf/contracts';
import { Injectable } from '@nestjs/common';

/** Open realtime streams allowed per user or API key in one API process (tabs, devices). */
export const MAX_STREAMS_PER_HOLDER = 5;

/** Counts open SSE connections per credential holder; refuses beyond the limit (429). */
@Injectable()
export class ConnectionLimiter {
  private readonly open = new Map<string, number>();

  /** Returns the release function, to call exactly once when the stream closes. */
  acquire(holder: string): () => void {
    const current = this.open.get(holder) ?? 0;
    if (current >= MAX_STREAMS_PER_HOLDER) {
      throw new RateLimitedError('Too many open realtime connections; close another tab.', 30);
    }
    this.open.set(holder, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(holder) ?? 1) - 1;
      if (left <= 0) this.open.delete(holder);
      else this.open.set(holder, left);
    };
  }

  get total(): number {
    return [...this.open.values()].reduce((sum, n) => sum + n, 0);
  }
}
