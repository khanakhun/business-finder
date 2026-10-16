import { describe, expect, it, vi } from 'vitest';
import type { ScoringQueue, ScoringRepository } from './ports.ts';
import { ScoringSubscribers } from './scoring.subscribers.ts';

const ORG = '01990000-0000-7000-8000-0000000000a1';
const OTHER = '01990000-0000-7000-8000-0000000000a2';
const BUSINESS = '01990000-0000-7000-8000-0000000000c1';

function setup() {
  const repository = {
    workspacesTracking: vi.fn(
      async () =>
        new Map([
          [ORG, [BUSINESS]],
          [OTHER, [BUSINESS]],
        ]),
    ),
    trackedByRun: vi.fn(async () => [BUSINESS, '01990000-0000-7000-8000-0000000000c2']),
  } as unknown as ScoringRepository;
  const queue: ScoringQueue = { compute: vi.fn(async () => {}), recompute: vi.fn(async () => {}) };
  return { subscribers: new ScoringSubscribers(repository, queue), queue };
}

const event = (orgId: string | null, payload: Record<string, unknown>) =>
  ({ id: 'evt-1', orgId, payload }) as never;

describe('ScoringSubscribers', () => {
  it('recomputes every workspace tracking a business on shared facts, one job key each', async () => {
    const { subscribers, queue } = setup();
    await subscribers.onSharedFacts(event(ORG, { businessId: BUSINESS }));
    expect(queue.compute).toHaveBeenCalledWith({
      organizationId: ORG,
      businessIds: [BUSINESS],
      idempotencyKey: `event:evt-1:${ORG}`,
    });
    expect(queue.compute).toHaveBeenCalledWith({
      organizationId: OTHER,
      businessIds: [BUSINESS],
      idempotencyKey: `event:evt-1:${OTHER}`,
    });
  });

  it('recomputes only the workspace on its own facts, and ignores events without one', async () => {
    const { subscribers, queue } = setup();
    await subscribers.onWorkspaceFacts(event(ORG, { businessId: BUSINESS }));
    expect(queue.compute).toHaveBeenCalledExactlyOnceWith({
      organizationId: ORG,
      businessIds: [BUSINESS],
      idempotencyKey: 'event:evt-1',
    });
    await subscribers.onWorkspaceFacts(event(null, { businessId: BUSINESS }));
    expect(queue.compute).toHaveBeenCalledTimes(1);
  });

  it('scores what a discovery run added when it ends', async () => {
    const { subscribers, queue } = setup();
    await subscribers.onDiscovered(event(ORG, { runId: 'run-1' }));
    expect(queue.compute).toHaveBeenCalledExactlyOnceWith({
      organizationId: ORG,
      businessIds: [BUSINESS, '01990000-0000-7000-8000-0000000000c2'],
      idempotencyKey: 'event:evt-1',
    });
  });
});
