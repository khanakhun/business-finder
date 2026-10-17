import type { AiGateway, SiteCopyInput, SitePlanInput } from '@bf/ai';
import type { DbClient } from '@bf/db';
import { businessContacts, businesses, generationJobs, orgBusinesses } from '@bf/db/schema';
import { QUEUES } from '@bf/queue';
import { aBusiness, aContact } from '@bf/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestWorker, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import { type Browser, createWorkspace, signUpVerified } from '../../../test/identity-helpers.ts';
import { AI_GATEWAY } from '../platform/ai/ai.module.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { InMemoryObjectStorage } from '../platform/storage/object-storage.ts';
import { GENERATION_ARTIFACTS } from './application/ports.ts';
import { GENERATION_REAPER_AUTOSTART } from './infrastructure/bullmq-generation-queues.ts';

// The blocks engine (BF-041) end to end: a batch through the worker — the workspace built from the business's facts
// (BF-040), the plan and each page's copy from a scripted model, the result checked and published.

const ENV = {
  SITES_BASE_DOMAIN: 'sites.test',
  SITES_ASSETS_BASE_URL: 'https://assets.bf-sites.test',
  GENERATION_BLOCKS_ENGINE: 'true',
  GENERATION_FAKE_ENGINE: 'false',
};

const calls: string[] = [];
const gateway = {
  async run(task: { name: string }, input: unknown) {
    calls.push(task.name);
    const output =
      task.name === 'generation.site_plan'
        ? {
            pages: (input as SitePlanInput).pages.map((page) => ({
              id: page.id,
              blocks: page.blocks.map((block) => ({
                id: block.id,
                variant: block.variant,
                intent: `Present ${block.type}`,
              })),
            })),
            heroConcept: 'Coffee on the harbour',
            warnings: [],
          }
        : {
            blocks: (input as SiteCopyInput).blocks.map((block) => ({
              blockId: block.blockId,
              fields: block.fields.map((field) => ({
                key: field.key,
                texts: Object.fromEntries(
                  (input as SiteCopyInput).locales.map((locale) => [locale, `Café Bleu · ${field.key}`]),
                ),
                factsUsed: [],
              })),
            })),
            seo: {
              title: Object.fromEntries(
                (input as SiteCopyInput).locales.map((locale) => [
                  locale,
                  `Café Bleu à Gustavia (${locale})`,
                ]),
              ),
              description: Object.fromEntries(
                (input as SiteCopyInput).locales.map((locale) => [
                  locale,
                  `Café Bleu sur le port de Gustavia : petit-déjeuner, brunch et café de spécialité, ouvert du matin au midi (${locale}).`,
                ]),
              ),
            },
            warnings: [],
          };
    if (task.name !== 'generation.site_plan' && task.name !== 'generation.site_copy')
      throw new Error(`unexpected task ${task.name}`);
    return {
      output,
      provider: 'anthropic',
      model: 'scripted',
      promptVersion: 1,
      usage: { inputTokens: 900, outputTokens: 400, cachedTokens: 0 },
      costUsd: 0.004,
      cached: false,
      latencyMs: 1,
    };
  },
} as unknown as AiGateway;

const store = new InMemoryObjectStorage();
const artifacts = {
  put: (key: string, body: Buffer, type: string) => store.put(key, body, type),
  get: async (key: string) => (await store.get(key))?.body,
};
const overrides = [
  { token: GENERATION_ARTIFACTS, value: artifacts },
  { token: AI_GATEWAY, value: gateway },
];

const mailer = new FakeMailer();
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let member: Browser;
let org: string;

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 26, env: ENV, overrides });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, {
    mailer,
    env: ENV,
    overrides: [...overrides, { token: GENERATION_REAPER_AUTOSTART, value: false }],
  });
  for (const queue of [QUEUES.generationBlocks.name, QUEUES.generationQuality.name])
    await worker.get<Queue>(getQueueToken(queue)).obliterate({ force: true });
  member = await signUpVerified(t, mailer, 'member@blocks.test', 'Bianca Blocks');
  org = await createWorkspace(member, 'Agence Blocs');
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

describe('blocks engine (BF-041)', () => {
  it('generates a site through the worker with the plan and the copy, checked and published', async () => {
    const row = aBusiness({ displayName: 'Café Bleu', locality: 'Gustavia', countryCode: 'BL' });
    await db.insert(businesses).values(row);
    await db.insert(orgBusinesses).values({ organizationId: org, businessId: row.id, addedVia: 'search' });
    await db
      .insert(businessContacts)
      .values(aContact({ businessId: row.id, type: 'phone', value: '+590590000123' }));
    const { body } = await member
      .post('/v1/generation-batches', { items: [{ businessId: row.id, engine: 'blocks' }] })
      .set('Idempotency-Key', 'batch-blocks-1')
      .expect(201);
    const deadline = Date.now() + 60_000;
    let status = '';
    while (Date.now() < deadline) {
      const [job] = await db
        .select({ status: generationJobs.status })
        .from(generationJobs)
        .where(eq(generationJobs.batchId, body.id));
      status = job?.status ?? '';
      if (['succeeded', 'needs_review', 'failed', 'cancelled'].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(status).toBe('succeeded');
    expect(calls[0]).toBe('generation.site_plan');
    expect(calls).toContain('generation.site_copy');
    const { body: detail } = await member.get(`/v1/generation-batches/${body.id}`).expect(200);
    const job = detail.jobs[0];
    expect(job).toMatchObject({ engineCurrent: 'blocks', status: 'succeeded' });
    expect(job.costUsd).toBeGreaterThan(0);
    const { body: jobDetail } = await member.get(`/v1/generation-jobs/${job.id}`).expect(200);
    const siteId = jobDetail.siteId ?? job.siteId;
    const { body: site } = await member.get(`/v1/sites/${siteId}`).expect(200);
    const { body: version } = await member
      .get(`/v1/sites/${siteId}/versions/${site.currentVersion.id}`)
      .expect(200);
    expect(site.currentVersionSummary).toMatchObject({
      errors: 0,
      changeSummary: 'Generated by blocks (attempt 1)',
    });
    expect(JSON.stringify(version.spec)).toContain('Café Bleu · heading');
  }, 90_000);
});
