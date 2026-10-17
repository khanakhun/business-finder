import { describe, expect, it } from 'vitest';
import { SandboxJanitor } from './janitor.ts';

// The sandbox janitor (BF-043): only containers older than their wall time plus the margin are removed.

describe('SandboxJanitor', () => {
  it('removes stale sandboxes and leaves running ones', async () => {
    const now = new Date('2026-10-17T12:00:00Z');
    const minutes = (n: number) => new Date(now.getTime() - n * 60_000);
    const calls: string[] = [];
    const janitor = new SandboxJanitor({
      async listContainers(labels) {
        expect(labels).toEqual(['bf.sandbox=true']);
        return [
          { id: 'fresh', created: minutes(10), labels: { 'bf.wall_time_sec': '1800' } },
          { id: 'stale', created: minutes(40), labels: { 'bf.wall_time_sec': '1800' } },
          { id: 'unlabelled-old', created: minutes(70), labels: {} },
          { id: 'unlabelled-young', created: minutes(30), labels: {} },
        ];
      },
      async kill(id) {
        calls.push(`kill:${id}`);
        if (id === 'stale') throw new Error('not running');
      },
      async remove(id) {
        calls.push(`remove:${id}`);
      },
    });
    expect(await janitor.sweep(now)).toBe(2);
    expect(calls).toEqual(['kill:stale', 'remove:stale', 'kill:unlabelled-old', 'remove:unlabelled-old']);
  });
});
