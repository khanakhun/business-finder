import {
  BudgetExceededError,
  ExternalServiceError,
  fixedClock,
  type ProviderQuery,
  RateLimitedError,
  ValidationError,
} from '@bf/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RUN_TASKS } from './planner.ts';
import { HEARTBEAT_MS, MAX_TASK_ATTEMPTS, RunOrchestrator } from './run-orchestrator.ts';
import type { RunRecord, TaskRecord } from './run-ports.ts';

// Fetch-step branches the integration tests do not reach: retries, permanent failures, monthly budget, result cap.
const query: ProviderQuery = {
  provider: 'google_places',
  categoryId: null,
  providerKeys: ['restaurant'],
  tile: { type: 'Circle', center: { lat: 17.9, lng: -62.85 }, radiusM: 1_500 },
  languageCode: 'fr',
  fieldTier: 'pro',
  mode: 'nearby',
  pageNumber: 0,
};
const counts = {
  tasksTotal: 1,
  tasksDone: 0,
  tasksFailed: 0,
  tasksSkipped: 0,
  recordsFetched: 0,
  created: 0,
  merged: 0,
  unchanged: 0,
  possibleDuplicates: 0,
  failedRecords: 0,
};
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-1',
  organizationId: 'org-1',
  createdBy: null,
  intent: { categoryIds: [], keywords: 'pizza', languageCode: 'fr' } as RunRecord['intent'],
  areaId: null,
  areaGeometry: { type: 'MultiPolygon', coordinates: [] },
  providers: ['google_places'],
  options: { autoEnrich: false, maxResults: 100, tileStrategy: 'auto' },
  status: 'running',
  reason: null,
  budgetUsd: 10,
  costUsd: 0,
  reservedUsd: 0,
  budgetExhausted: false,
  counts,
  ingestsPending: 0,
  requestHash: null,
  plannedAt: new Date(0),
  startedAt: null,
  finishedAt: null,
  createdAt: new Date(0),
  ...over,
});
const task = (over: Partial<TaskRecord> = {}): TaskRecord =>
  ({
    id: 'task-1',
    runId: 'run-1',
    parentTaskId: null,
    provider: 'google_places',
    categoryId: null,
    query,
    depth: 0,
    status: 'running',
    attempt: 1,
    ...over,
  }) as TaskRecord;

function setup(fetchPage: () => Promise<unknown>, current: RunRecord = run(), claimed: TaskRecord = task()) {
  const runs = {
    getRun: vi.fn(async () => current),
    getTask: vi.fn(async () => ({ ...claimed, status: 'queued' })),
    claimTask: vi.fn(async () => claimed),
    reserve: vi.fn(async () => true),
    releaseReservation: vi.fn(async () => undefined),
    completeTask: vi.fn(async () => ({ accepted: true, created: [] as TaskRecord[] })),
    heartbeat: vi.fn(async () => undefined),
    failTask: vi.fn(async () => undefined),
    requeueTask: vi.fn(async () => undefined),
    skipTask: vi.fn(async () => true),
    skipQueued: vi.fn(async () => 0),
    markStop: vi.fn(async () => undefined),
    addTasks: vi.fn(async () => []),
  };
  const provider = {
    id: 'google_places',
    capabilities: { circle: true, bbox: false, pagination: true, maxResultsPerQuery: 60 },
    skuFor: () => 'nearby_pro',
    maxPages: () => 3,
    fetchPage: vi.fn(fetchPage),
  };
  const queue = { fetch: vi.fn(), ingest: vi.fn(), plan: vi.fn(), cancelFetches: vi.fn() };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const orchestrator = new RunOrchestrator(
    runs as never,
    queue as never,
    { progressed: vi.fn(), finished: vi.fn() } as never,
    { get: () => provider } as never,
    {} as never,
    { estimateCalls: async () => ({ totalUsd: 0.032 }) } as never,
    {} as never,
    {} as never,
    {} as never,
    fixedClock('2026-10-14T12:00:00.000Z'),
    logger as never,
  );
  const finalize = vi.spyOn(orchestrator, 'finalizeIfDone').mockResolvedValue(undefined);
  return { orchestrator, runs, provider, queue, finalize };
}

const signal = new AbortController().signal;

describe('RunOrchestrator.fetch', () => {
  let s: ReturnType<typeof setup>;

  describe('transient failures', () => {
    for (const [label, error] of [
      ['rate limit', new RateLimitedError('slow down', 2)],
      ['provider outage', new ExternalServiceError('google', 'HTTP 503')],
      ['unexpected error', new TypeError('socket hang up')],
    ] as const) {
      it(`${label}: requeues (releasing the reservation) and rethrows for a BullMQ retry`, async () => {
        s = setup(async () => Promise.reject(error));
        await expect(s.orchestrator.fetch('run-1', 'task-1', signal)).rejects.toBe(error);
        expect(s.runs.reserve).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }), 0.032);
        expect(s.runs.requeueTask).toHaveBeenCalledWith('task-1');
        expect(s.runs.failTask).not.toHaveBeenCalled();
      });
    }

    it('fails the task on the last attempt instead of retrying', async () => {
      s = setup(
        async () => Promise.reject(new RateLimitedError('slow down')),
        run(),
        task({ attempt: MAX_TASK_ATTEMPTS }),
      );
      await s.orchestrator.fetch('run-1', 'task-1', signal);
      expect(s.runs.failTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }), 'RATE_LIMITED');
      expect(s.runs.requeueTask).not.toHaveBeenCalled();
      expect(s.finalize).toHaveBeenCalledWith('run-1');
    });
  });

  it('fails permanently on non-retryable errors', async () => {
    s = setup(async () => Promise.reject(new ValidationError('bad query')));
    await s.orchestrator.fetch('run-1', 'task-1', signal);
    expect(s.runs.failTask).toHaveBeenCalledWith(expect.anything(), 'VALIDATION_FAILED');
    expect(s.runs.requeueTask).not.toHaveBeenCalled();
  });

  it('stops the run on the monthly budget: no more queued work', async () => {
    s = setup(async () => Promise.reject(new BudgetExceededError('monthly budget reached')));
    await s.orchestrator.fetch('run-1', 'task-1', signal);
    expect(s.runs.markStop).toHaveBeenCalledWith('run-1', 'monthly_budget');
    expect(s.runs.skipQueued).toHaveBeenCalledWith('run-1', 'monthly_budget');
    expect(s.runs.failTask).not.toHaveBeenCalled();
  });

  it('stops the run when the reservation does not fit the run budget, without calling the provider', async () => {
    s = setup(async () => ({ records: [], saturated: false, nextPageToken: null }));
    s.runs.reserve.mockResolvedValue(false);
    await s.orchestrator.fetch('run-1', 'task-1', signal);
    expect(s.provider.fetchPage).not.toHaveBeenCalled();
    expect(s.runs.markStop).toHaveBeenCalledWith('run-1', 'budget');
  });

  it('skips tasks once the result cap is reached', async () => {
    s = setup(
      async () => ({ records: [], saturated: false, nextPageToken: null }),
      run({ counts: { ...counts, recordsFetched: 100 } }),
    );
    await s.orchestrator.fetch('run-1', 'task-1', signal);
    expect(s.provider.fetchPage).not.toHaveBeenCalled();
    expect(s.runs.skipTask).toHaveBeenCalledWith(expect.anything(), 'result cap reached');
  });

  it('skips the task of a cancelled run without claiming it', async () => {
    s = setup(
      async () => ({ records: [], saturated: false, nextPageToken: null }),
      run({ status: 'cancelled' }),
    );
    await s.orchestrator.fetch('run-1', 'task-1', signal);
    expect(s.runs.claimTask).not.toHaveBeenCalled();
    expect(s.runs.skipTask).toHaveBeenCalledWith(expect.anything(), 'cancelled');
  });

  it('treats an aborted call as cancelled, not failed', async () => {
    const controller = new AbortController();
    s = setup(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await s.orchestrator.fetch('run-1', 'task-1', controller.signal);
    expect(s.runs.skipTask).toHaveBeenCalledWith(expect.anything(), 'cancelled');
    expect(s.runs.failTask).not.toHaveBeenCalled();
  });

  it('commits the next page with the completion and enqueues it with its poll delay', async () => {
    s = setup(async () => ({ records: [], saturated: false, nextPageToken: 'next', pollAfterMs: 2_000 }));
    const continuation = task({
      id: 'task-2',
      status: 'queued',
      notBefore: new Date('2026-10-14T12:00:02.000Z'),
    });
    s.runs.completeTask.mockResolvedValue({ accepted: true, created: [continuation] });
    await s.orchestrator.fetch('run-1', 'task-1', signal);
    const [, outcome, follow] = s.runs.completeTask.mock.calls[0] as unknown as [
      TaskRecord,
      { costUsd: number },
      Array<{ query: ProviderQuery; notBefore: Date }>,
    ];
    expect(outcome.costUsd).toBe(0);
    expect(follow).toHaveLength(1);
    expect(follow[0]?.query).toMatchObject({ pageToken: 'next', pageNumber: 1 });
    expect(follow[0]?.notBefore.toISOString()).toBe('2026-10-14T12:00:02.000Z');
    expect(s.queue.fetch).toHaveBeenCalledWith(continuation, 'org-1', 2_000);
    expect(s.queue.ingest).not.toHaveBeenCalled(); // no records, nothing to ingest
  });

  it('drops splits past the run task cap', async () => {
    s = setup(
      async () => ({ records: [], saturated: true, nextPageToken: null }),
      run({ counts: { ...counts, tasksTotal: MAX_RUN_TASKS } }),
    );
    await s.orchestrator.fetch('run-1', 'task-1', signal);
    expect((s.runs.completeTask.mock.calls[0] as unknown[])[2]).toEqual([]);
  });

  it('enqueues nothing when the completion is refused (run cancelled meanwhile)', async () => {
    s = setup(async () => ({ records: [{ name: 'x' }], saturated: false, nextPageToken: 'next' }));
    s.runs.completeTask.mockResolvedValue({ accepted: false, created: [] });
    await s.orchestrator.fetch('run-1', 'task-1', signal);
    expect(s.queue.ingest).not.toHaveBeenCalled();
    expect(s.queue.fetch).not.toHaveBeenCalled();
    expect(s.finalize).toHaveBeenCalledWith('run-1');
  });

  it('heartbeats while a call is slow', async () => {
    vi.useFakeTimers();
    try {
      let resolve: (page: unknown) => void = () => undefined;
      s = setup(() => new Promise((r) => (resolve = r)));
      const pending = s.orchestrator.fetch('run-1', 'task-1', signal);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2 + 1);
      expect(s.runs.heartbeat).toHaveBeenCalledTimes(2);
      resolve({ records: [], saturated: false, nextPageToken: null });
      await pending;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
      expect(s.runs.heartbeat).toHaveBeenCalledTimes(2); // stopped with the call
    } finally {
      vi.useRealTimers();
    }
  });
});

beforeEach(() => vi.clearAllMocks());
