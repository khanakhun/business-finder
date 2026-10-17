import type { DbClient } from '@bf/db';
import {
  auditLogs,
  businessContacts,
  businesses,
  generationAttempts,
  generationJobs,
  orgBusinesses,
} from '@bf/db/schema';
import { QUEUES } from '@bf/queue';
import { aBusiness, aContact } from '@bf/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestWorker, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import { type Browser, createWorkspace, signUpVerified } from '../../../test/identity-helpers.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { InMemoryObjectStorage } from '../platform/storage/object-storage.ts';
import { GENERATION_ARTIFACTS } from './application/ports.ts';
import { GENERATION_REAPER_AUTOSTART } from './infrastructure/bullmq-generation-queues.ts';

// Reviewing a generated version (BF-045): a site whose copy keeps failing the gates (a placeholder in the business's
// name reaches its texts) is repaired twice, then waits for review with its quality report. A person reads the
// report, asks for another repair, and publishes it anyway with a recorded reason; outsiders see nothing.

const ENV = {
  SITES_BASE_DOMAIN: 'sites.test',
  SITES_ASSETS_BASE_URL: 'https://assets.bf-sites.test',
  GENERATION_FAKE_ENGINE: 'true',
  GENERATION_BLOCKS_ENGINE: 'false',
};

const store = new InMemoryObjectStorage();
const overrides = [
  {
    token: GENERATION_ARTIFACTS,
    value: {
      put: (key: string, body: Buffer, type: string) => store.put(key, body, type),
      get: async (key: string) => (await store.get(key))?.body,
    },
  },
];

const mailer = new FakeMailer();
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let owner: Browser;
let outsider: Browser;
let org: string;

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 31, env: ENV, overrides });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, {
    mailer,
    env: ENV,
    overrides: [...overrides, { token: GENERATION_REAPER_AUTOSTART, value: false }],
  });
  for (const queue of [QUEUES.generationFake.name, QUEUES.generationQuality.name])
    await worker.get<Queue>(getQueueToken(queue)).obliterate({ force: true });
  owner = await signUpVerified(t, mailer, 'owner@review.test', 'Rita Review');
  org = await createWorkspace(owner, 'Agence Revue');
  outsider = await signUpVerified(t, mailer, 'outsider@review.test', 'Oscar Outside');
  await createWorkspace(outsider, 'Autre agence');
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

async function reviewedJob(name: string, key: string) {
  const row = aBusiness({ displayName: name, locality: 'Gustavia', countryCode: 'BL' });
  await db.insert(businesses).values(row);
  await db.insert(orgBusinesses).values({ organizationId: org, businessId: row.id, addedVia: 'search' });
  await db
    .insert(businessContacts)
    .values(aContact({ businessId: row.id, type: 'phone', value: '+590590000188' }));
  const { body } = await owner
    .post('/v1/generation-batches', { items: [{ businessId: row.id, engine: 'fake' }] })
    .set('Idempotency-Key', key)
    .expect(201);
  return settle(body.id, 'needs_review');
}

async function settle(batchId: string, expected: string) {
  const deadline = Date.now() + 90_000;
  let job: typeof generationJobs.$inferSelect | undefined;
  while (Date.now() < deadline) {
    [job] = await db.select().from(generationJobs).where(eq(generationJobs.batchId, batchId));
    if (job?.status === expected) return job;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`the job did not reach ${expected} (last: ${job?.status})`);
}

describe('reviewing a generated version (BF-045)', () => {
  it('serves the report, repairs on request, and publishes it anyway with a recorded reason', async () => {
    const job = await reviewedJob('Salon [x]', 'review-batch-1');
    const { body } = await owner.get(`/v1/generation-jobs/${job.id}/quality`).expect(200);
    expect(body.report).toMatchObject({ decision: 'needs_review', infraError: false });
    const gates = Object.fromEntries(
      (body.report.gates as { id: string; status: string }[]).map((g) => [g.id, g.status]),
    );
    expect(gates).toMatchObject({ schema: 'pass', facts: 'pass', copy: 'fail' });
    expect(body.report.issues.some((issue: { code: string }) => issue.code === 'copy.placeholder')).toBe(
      true,
    );
    await outsider.get(`/v1/generation-jobs/${job.id}/quality`).expect(404);
    await owner.get(`/v1/generation-jobs/${job.id}/quality/screenshots/0`).expect(404);

    // Another repair, on request: the same engine, a repair attempt, back to review.
    const before = (await db.select().from(generationAttempts).where(eq(generationAttempts.jobId, job.id)))
      .length;
    const { body: repairing } = await owner.post(`/v1/generation-jobs/${job.id}/repair`, {}).expect(200);
    expect(repairing.status).toBe('repairing');
    await settle(job.batchId, 'needs_review');
    const attempts = await db.select().from(generationAttempts).where(eq(generationAttempts.jobId, job.id));
    expect(attempts.length).toBe(before + 1);
    expect(attempts.at(-1)?.mode).toBe('repair');

    // Accept anyway: a reason is required; the version is published; who and why are recorded.
    await owner.post(`/v1/generation-jobs/${job.id}/accept`, { reason: 'short' }).expect(422);
    await outsider
      .post(`/v1/generation-jobs/${job.id}/accept`, { reason: 'The placeholder is the real business name.' })
      .expect(404);
    const { body: accepted } = await owner
      .post(`/v1/generation-jobs/${job.id}/accept`, {
        reason: 'The brackets are part of the real business name.',
      })
      .expect(200);
    expect(accepted).toMatchObject({ status: 'succeeded' });
    expect(accepted.publishedUrl).toMatch(/sites\.test/);
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'generation.version_accepted'), eq(auditLogs.entityId, job.id)));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]?.metadata)).toContain('real business name');
    // Once published, there is nothing left to accept or repair.
    await owner
      .post(`/v1/generation-jobs/${job.id}/accept`, { reason: 'The brackets are part of the name.' })
      .expect(409);
    await owner.post(`/v1/generation-jobs/${job.id}/repair`, {}).expect(409);
  }, 240_000);
});
