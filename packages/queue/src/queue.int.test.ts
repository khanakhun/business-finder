import { Writable } from 'node:stream';
import { defineJob, newId } from '@bf/contracts';
import { createLogger, initTelemetry, startSpan } from '@bf/observability';
import { testValkeyUrl } from '@bf/testing/valkey';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { type Job, Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { requestCancellation } from './cancellation.ts';
import { TypedProducer } from './producer.ts';
import { createJobRunner, type JobContext } from './runner.ts';

const exporter = new InMemorySpanExporter();
const telemetry = initTelemetry({
  serviceName: 'queue-test',
  exporter: 'none',
  autoInstrument: false,
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const logger = createLogger({
  service: 'queue-test',
  level: 'fatal',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

const QUEUE = 'queue-int-test';
const Echo = defineJob(QUEUE, 'echo', { text: z.string(), sleepMs: z.number().int().default(0) });

let valkey: Redis;
let queue: Queue;
let events: QueueEvents;
let worker: Worker;
const handled: Array<{ text: string; context: JobContext }> = [];

beforeAll(async () => {
  const url = testValkeyUrl(3);
  valkey = new Redis(url, { maxRetriesPerRequest: null });
  await valkey.flushdb();
  queue = new Queue(QUEUE, {
    connection: new Redis(url, { maxRetriesPerRequest: null }),
    defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 50 } },
  });
  events = new QueueEvents(QUEUE, { connection: new Redis(url, { maxRetriesPerRequest: null }) });
  await events.waitUntilReady();
  const run = createJobRunner(
    Echo,
    async (payload, context) => {
      handled.push({ text: payload.text, context });
      await context.progress(50);
      const deadline = Date.now() + payload.sleepMs;
      while (Date.now() < deadline) {
        if (context.signal.aborted) throw context.signal.reason;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await startSpan('echo.work', {}, async () => undefined);
      return `echo:${payload.text}`;
    },
    { valkey, logger, cancelPollMs: 20 },
  );
  worker = new Worker(QUEUE, (job, token, signal) => run(job, token, signal), {
    connection: new Redis(url, { maxRetriesPerRequest: null }),
    concurrency: 4,
  });
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker.close();
  await events.close();
  await queue.close();
  valkey.disconnect();
  await telemetry.shutdown();
});

const finished = (jobId: string) =>
  queue.getJob(jobId).then((job) => (job as Job).waitUntilFinished(events, 10_000));

describe('producer + runner', () => {
  it('processes a valid job and reports progress', async () => {
    const jobId = await new TypedProducer(queue, Echo).add({
      idempotencyKey: newId(),
      orgId: null,
      text: 'hello',
    });
    expect(await finished(jobId)).toEqual({ status: 'processed', result: 'echo:hello' });
    expect((await queue.getJob(jobId))?.progress).toBe(50);
    expect(handled.find((h) => h.text === 'hello')?.context.attempt).toBe(1);
  });

  it('rejects invalid payloads before enqueueing', async () => {
    await expect(
      new TypedProducer(queue, Echo).add({ idempotencyKey: '', orgId: null, text: 'x' }),
    ).rejects.toThrow();
    expect(() => new TypedProducer(new Queue('other', { connection: valkey }), Echo)).toThrow(
      /cannot be added/,
    );
  });

  it('collapses duplicate keys while queued, and skips completed keys on replay', async () => {
    const key = newId();
    const producer = new TypedProducer(queue, Echo);
    const first = await producer.add({ idempotencyKey: key, orgId: null, text: 'once' });
    const second = await producer.add({ idempotencyKey: key, orgId: null, text: 'once' });
    expect(second).toBe(first);
    await finished(first);
    // Replay after the job left the queue (e.g. retention expired): the runner remembers completion.
    await (await queue.getJob(first))?.remove();
    const replay = await producer.add({ idempotencyKey: key, orgId: null, text: 'once' });
    expect(await finished(replay)).toEqual({ status: 'skipped' });
    expect(handled.filter((h) => h.text === 'once')).toHaveLength(1);
  });

  it('fails invalid payloads without retrying', async () => {
    const job = await queue.add('echo', { idempotencyKey: newId(), orgId: null, text: 42 });
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(
      /Invalid queue-int-test\/echo payload/,
    );
    expect((await queue.getJob(job.id ?? ''))?.attemptsMade).toBe(1);
  });

  it('cancels a running job from another process, without retrying it', async () => {
    const jobId = await new TypedProducer(queue, Echo).add({
      idempotencyKey: newId(),
      orgId: null,
      text: 'slow',
      sleepMs: 5_000,
    });
    await expect.poll(() => handled.some((h) => h.text === 'slow'), { timeout: 5_000 }).toBe(true);
    const started = Date.now();
    await requestCancellation(valkey, QUEUE, jobId);
    await expect(finished(jobId)).rejects.toThrow(/was cancelled/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await queue.getJob(jobId))?.attemptsMade).toBe(1);
  });

  it('continues the producer trace in the worker', async () => {
    exporter.reset();
    const echo = new TypedProducer(queue, Echo);
    const jobId = await startSpan('test.enqueue', {}, () =>
      echo.add({ idempotencyKey: newId(), orgId: null, text: 'traced' }),
    );
    await finished(jobId);
    await telemetry.forceFlush();
    const spans = exporter.getFinishedSpans();
    const producer = spans.find((s) => s.name === 'test.enqueue');
    const consumer = spans.find((s) => s.name === `job.process ${QUEUE}`);
    const work = spans.find((s) => s.name === 'echo.work');
    expect(consumer?.spanContext().traceId).toBe(producer?.spanContext().traceId);
    expect(work?.parentSpanContext?.spanId).toBe(consumer?.spanContext().spanId);
  });
});
