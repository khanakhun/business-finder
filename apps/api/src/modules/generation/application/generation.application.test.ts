import { fixedClock } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransactionalDb } from '../../platform/db/transactional.ts';
import type { EventRecorder } from '../../platform/events/event-recorder.ts';
import type { Logger } from '../../platform/logging/logger.ts';
import {
  DefaultGenerationSettings,
  FixtureWorkspacePreparer,
  SchemaOnlyQualityPipeline,
  StaticEngineRegistry,
} from '../infrastructure/defaults/defaults.ts';
import { FakeEngine } from '../infrastructure/defaults/fake.engine.ts';
import { GenerationCommands } from './generation.commands.ts';
import { GenerationQuality } from './generation.quality.ts';
import { GenerationQueries } from './generation.queries.ts';
import { GenerationRunner } from './generation.runner.ts';
import type { GenerationLimits, SiteHandOff, WorkspaceBudget } from './ports.ts';
import { InMemoryGenerationRepository, InMemoryLeases, RecordingQueues } from './testing.ts';
import { JobTransitions } from './transitions.ts';

const ORG = '0199e0a0-0000-7000-8000-000000000001';
const actor = { organizationId: ORG, userId: 'user-1' };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const passthroughDb = { transaction: async (fn: (tx: unknown) => unknown) => fn({}) } as unknown as DbClient;
beforeAll(() => setTransactionalDb(passthroughDb));
afterAll(() => setTransactionalDb(undefined));

const LIMITS: GenerationLimits = {
  maxSandboxes: 2,
  heartbeatTimeoutMs: 120_000,
  heartbeatEveryMs: 50,
  attemptTimeoutMs: 10_000,
  slotRetryMs: 1_000,
  maxSpecBytes: 1_000_000,
};

let repository: InMemoryGenerationRepository;
let queues: RecordingQueues;
let leases: InMemoryLeases;
let events: { record: ReturnType<typeof vi.fn> };
let store: Map<string, Buffer>;
let budget: WorkspaceBudget & { check: ReturnType<typeof vi.fn> };
let cancelled: Set<string>;
let handOff: SiteHandOff & {
  createVersion: ReturnType<typeof vi.fn>;
  publishPreview: ReturnType<typeof vi.fn>;
};
let commands: GenerationCommands;
let runner: GenerationRunner;
let quality: GenerationQuality;
let queries: GenerationQueries;

const business = (name: string) => {
  const id = crypto.randomUUID();
  repository.names.set(id, name);
  return id;
};

beforeEach(() => {
  repository = new InMemoryGenerationRepository();
  queues = new RecordingQueues();
  leases = new InMemoryLeases();
  events = { record: vi.fn(async () => ({})) };
  store = new Map();
  budget = { check: vi.fn(async (): Promise<'ok' | 'soft' | 'hard'> => 'ok') };
  cancelled = new Set();
  handOff = {
    createVersion: vi.fn(async () => ({ siteId: 'site-1', versionId: 'version-1' })),
    publishPreview: vi.fn(async () => 'https://x.sites.test/'),
  };
  const clock = fixedClock('2026-10-16T12:00:00.000Z');
  const engines = new StaticEngineRegistry([
    new FakeEngine({ durationMs: 4, assetsBaseUrl: 'https://assets.bf-sites.test' }),
  ]);
  const settings = new DefaultGenerationSettings(() => engines.list().map((engine) => engine.id));
  const preparer = new FixtureWorkspacePreparer(async (key, body) => {
    store.set(key, body);
  });
  const artifacts = {
    put: async (key: string, body: Buffer) => void store.set(key, body),
    get: async (key: string) => store.get(key),
  };
  const cancels = {
    request: async (jobId: string) => void cancelled.add(jobId),
    watch: (jobId: string) => {
      const controller = new AbortController();
      if (cancelled.has(jobId)) controller.abort();
      return { signal: controller.signal, stop: () => undefined };
    },
  };
  const transitions = new JobTransitions(
    repository,
    queues,
    engines,
    clock,
    events as unknown as EventRecorder,
  );
  commands = new GenerationCommands(
    repository,
    engines,
    queues,
    settings,
    preparer,
    budget,
    cancels,
    clock,
    transitions,
  );
  runner = new GenerationRunner(
    repository,
    engines,
    queues,
    leases,
    cancels,
    { publish: async () => undefined, status: async () => undefined },
    artifacts,
    preparer,
    budget,
    settings,
    LIMITS,
    clock,
    transitions,
  );
  quality = new GenerationQuality(
    repository,
    engines,
    queues,
    artifacts,
    new SchemaOnlyQualityPipeline(['assets.bf-sites.test']),
    handOff,
    LIMITS,
    clock,
    transitions,
    runner,
  );
  queries = new GenerationQueries(repository, engines);
});

/** Runs what the queues hold, like the workers would, until nothing is left (bounded). */
async function drain(max = 20) {
  for (let i = 0; i < max; i++) {
    const run = queues.runs.shift();
    if (run) {
      await runner.run(run.jobId, run.attemptNo, logger);
      continue;
    }
    const check = queues.quality_.shift();
    if (check) {
      await quality.evaluate(check.jobId, check.attemptId, logger);
      continue;
    }
    return;
  }
}

describe('generation (unit, in memory)', () => {
  it('creates a batch with auto-selected engines, runs it to a published preview and reads it back', async () => {
    const ids = [business('Café'), business('Salon')];
    const { batch, created } = await commands.createBatch(
      actor,
      { items: ids.map((businessId) => ({ businessId })) },
      'key-0001',
    );
    expect(created).toBe(true);
    expect(queues.runs).toHaveLength(2);
    const again = await commands.createBatch(
      actor,
      { items: ids.map((businessId) => ({ businessId })) },
      'key-0001',
    );
    expect(again).toMatchObject({ created: false, batch: { id: batch.id } });
    await expect(
      commands.createBatch(actor, { items: [{ businessId: ids[0] as never }] }, 'key-0001'),
    ).rejects.toThrow(/Idempotency/);
    await drain();
    const detail = await queries.batch(ORG, batch.id);
    expect(detail.status).toBe('completed');
    expect(detail.jobs.map((job) => job.status)).toEqual(['succeeded', 'succeeded']);
    expect(detail.jobs[0]).toMatchObject({
      publishedUrl: 'https://x.sites.test/',
      resultVersionId: 'version-1',
    });
    expect(handOff.createVersion).toHaveBeenCalledTimes(2);
    const job = await queries.job(ORG, detail.jobs[0]?.id ?? '');
    expect(job.attempts[0]).toMatchObject({ engine: 'fake', status: 'succeeded' });
    expect((await queries.batches(ORG, { limit: 10 })).items).toHaveLength(1);
    expect((await queries.listEngines(ORG)).items[0]).toMatchObject({ id: 'fake', available: true });
    expect(events.record).toHaveBeenCalled();
    // Every lease went back.
    expect(await leases.held('gen:slots:sandboxes')).toBe(0);
  });

  it('refuses unknown businesses, unregistered engines and a spent workspace budget', async () => {
    await expect(
      commands.createBatch(actor, { items: [{ businessId: crypto.randomUUID() as never }] }, null),
    ).rejects.toThrow(/cannot be generated/);
    await expect(
      commands.createBatch(actor, { items: [{ businessId: business('X') as never, engine: 'codex' }] }, null),
    ).rejects.toThrow(/cannot be generated/);
    budget.check.mockResolvedValueOnce('hard');
    await expect(
      commands.createBatch(actor, { items: [{ businessId: business('Y') as never }] }, null),
    ).rejects.toThrow(/budget/);
  });

  it('repairs an invalid result, retries a flaky one and fails a fatal one', async () => {
    const { batch } = await commands.createBatch(
      actor,
      {
        items: ['Atelier [invalid]', 'Boutique [fail-once:TIMEOUT]', 'Garage [fail:POLICY_VIOLATION]'].map(
          (name) => ({ businessId: business(name) as never, engine: 'fake' as const }),
        ),
      },
      null,
    );
    await drain(40);
    const detail = await queries.batch(ORG, batch.id);
    const byName = new Map(detail.jobs.map((job) => [job.businessName, job]));
    expect(byName.get('Atelier [invalid]')).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    expect(byName.get('Boutique [fail-once:TIMEOUT]')).toMatchObject({
      status: 'succeeded',
      attemptCount: 2,
    });
    expect(byName.get('Garage [fail:POLICY_VIOLATION]')).toMatchObject({
      status: 'failed',
      errorCode: 'POLICY_VIOLATION',
    });
    expect(detail.status).toBe('completed_with_issues');
    // A retry queues a new attempt.
    const garage = byName.get('Garage [fail:POLICY_VIOLATION]');
    const retried = await commands.retry(actor, garage?.id ?? '');
    expect(retried.status).toBe('queued');
    await expect(commands.retry(actor, byName.get('Atelier [invalid]')?.id ?? '')).rejects.toThrow(/retried/);
  });

  it('defers a run without a sandbox, releases a sequential batch in priority order, and cancels', async () => {
    const ids = ['Un', 'Deux', 'Trois'].map((name) => business(name));
    const { batch } = await commands.createBatch(
      actor,
      {
        items: ids.map((businessId, index) => ({
          businessId: businessId as never,
          engine: 'fake' as const,
          priority: 3 - index,
        })),
        settings: { maxParallel: 1 },
      },
      null,
    );
    expect(queues.runs.map((run) => run.jobId)).toHaveLength(1);
    const jobs = await repository.jobs(batch.id);
    expect(queues.runs[0]?.jobId).toBe(jobs[0]?.id);
    expect(repository.names.get(jobs[0]?.businessId ?? '')).toBe('Trois');

    // No sandbox free: deferred, no attempt counted.
    await leases.acquire('gen:slots:sandboxes', 2);
    await leases.acquire('gen:slots:sandboxes', 2);
    const first = queues.runs.shift();
    expect(await runner.run(first?.jobId ?? '', 1, logger)).toBe('deferred');
    expect(queues.runs[0]).toMatchObject({ jobId: first?.jobId, attemptNo: 1, delayMs: expect.any(Number) });
    leases.held_.clear();

    // Waiting jobs: cancelled at once; reprioritized; the engine changed.
    const waiting = jobs[2];
    await commands.update(actor, jobs[1]?.id ?? '', { priority: 9 });
    await expect(commands.update(actor, jobs[1]?.id ?? '', { engine: 'codex' })).rejects.toThrow(
      /not available/,
    );
    await commands.reorder(actor, batch.id, [jobs[1]?.id ?? '', waiting?.id ?? '']);
    const stopped = await commands.cancel(actor, waiting?.id ?? '');
    expect(stopped.status).toBe('cancelled');
    await drain(20);
    const detail = await queries.batch(ORG, batch.id);
    expect(detail.jobs.map((job) => job.status).sort()).toEqual(['cancelled', 'succeeded', 'succeeded']);

    // A running job is cancelled through its signal.
    const { batch: other } = await commands.createBatch(
      actor,
      { items: [{ businessId: business('Lent') as never, engine: 'fake' }] },
      null,
    );
    const [job] = await repository.jobs(other.id);
    await repository.updateJob(job?.id ?? '', { status: 'running' });
    await commands.cancel(actor, job?.id ?? '');
    expect(cancelled.has(job?.id ?? '')).toBe(true);
    await commands.cancelBatch(actor, other.id);
  });

  it('reaps an attempt whose worker died and fails over or fails a job that cannot start', async () => {
    const { batch } = await commands.createBatch(
      actor,
      { items: [{ businessId: business('Mort') as never, engine: 'fake' }] },
      null,
    );
    const [job] = await repository.jobs(batch.id);
    queues.runs.length = 0;
    await repository.updateJob(job?.id ?? '', { status: 'running', attemptCount: 1, engineAttempts: 1 });
    await repository.insertAttempt({
      id: crypto.randomUUID(),
      jobId: job?.id ?? '',
      attemptNo: 1,
      engine: 'fake',
      mode: 'create',
    });
    for (const attempt of repository.attemptRows.values())
      repository.attemptRows.set(attempt.id, { ...attempt, heartbeatAt: new Date('2026-10-16T11:00:00Z') });
    expect(await quality.reap(logger)).toEqual({ reaped: 1, events: 0 });
    expect(queues.runs[0]).toMatchObject({ jobId: job?.id, attemptNo: 2 });
    await drain();
    expect((await queries.job(ORG, job?.id ?? '')).status).toBe('succeeded');

    // The workspace's budget is spent between creation and start: failed for good.
    const { batch: late } = await commands.createBatch(
      actor,
      { items: [{ businessId: business('Tard') as never, engine: 'fake' }] },
      null,
    );
    budget.check.mockResolvedValue('hard');
    await drain();
    expect((await queries.batch(ORG, late.id)).jobs[0]).toMatchObject({
      status: 'failed',
      errorCode: 'BUDGET_EXCEEDED',
    });
  });

  it('sends a site the sites module refuses to review, and keeps an unrepairable one unpublished', async () => {
    handOff.createVersion.mockRejectedValueOnce(new Error('refused'));
    const { batch } = await commands.createBatch(
      actor,
      { items: [{ businessId: business('Refusé') as never, engine: 'fake' }] },
      null,
    );
    await drain();
    expect((await queries.batch(ORG, batch.id)).jobs[0]).toMatchObject({
      status: 'needs_review',
      errorCode: 'SPEC_REFUSED',
    });
    const pipeline = new SchemaOnlyQualityPipeline(['elsewhere.example']);
    const verdict = await pipeline.evaluate({
      job: (await repository.jobs(batch.id))[0] as never,
      spec: JSON.parse(
        store.get([...store.keys()].find((key) => key.endsWith('site.json')) ?? '')?.toString() ?? '{}',
      ),
      repairsLeft: 0,
      supportsRepair: true,
    });
    expect(verdict.outcome).toBe('needs_review');
  });
});
