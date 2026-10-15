import type { AiGateway } from '@bf/ai';
import { fakeEmbedding } from '@bf/ai/testing';
import type { DbClient } from '@bf/db';
import { businesses } from '@bf/db/schema';
import type { INestApplicationContext } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestWorker, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import { type Browser, createWorkspace, signUpVerified } from '../../../test/identity-helpers.ts';
import { AI_GATEWAY } from '../platform/ai/ai.module.ts';
import { APP_ENV } from '../platform/config/app-env.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { BusinessEmbedder } from './application/business-embedder.ts';

// Business embeddings (BF-022) end to end: a created business is embedded by the worker (outbox → subscriber →
// search queue → processor), becomes findable by meaning, and the backfill re-embeds rows of another model.

const embedded: string[] = [];
const fakeGateway = {
  embed: async (texts: readonly string[]) => {
    embedded.push(...texts);
    return { vectors: texts.map((t) => fakeEmbedding(t)), model: 'fake', dims: 1536 };
  },
} as unknown as AiGateway;

const mailer = new FakeMailer();
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let owner: Browser;

const embeddingOf = async (id: string) => {
  const [row] = await db
    .select({ model: businesses.embeddingModel, hash: businesses.embeddingTextHash })
    .from(businesses)
    .where(eq(businesses.id, id));
  return row;
};

beforeAll(async () => {
  const overrides = [{ token: AI_GATEWAY, value: fakeGateway }];
  t = await createTestApp({ mailer, valkeyDb: 6, overrides });
  worker = await createTestWorker(t, { mailer, overrides });
  db = t.app.get(DB_CLIENT);
  owner = await signUpVerified(t, mailer, 'owner@embed.test', 'Emma Embed');
  await createWorkspace(owner, 'Agence Vecteur');
});

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

describe('business embeddings', () => {
  it('embeds a created business in the worker and finds it by meaning', async () => {
    const created = await owner
      .post('/v1/businesses', {
        displayName: 'Le Hamac Bleu',
        countryCode: 'BL',
        locality: 'Gustavia',
        location: { lat: 17.8962, lng: -62.8498 },
      })
      .expect(201);
    const id: string = created.body.id;
    await expect
      .poll(async () => (await embeddingOf(id))?.model, { timeout: 20_000, interval: 100 })
      .toBe(t.app.get(APP_ENV).AI_EMBEDDING_MODEL);
    const text = embedded.find((e) => e.startsWith('Le Hamac Bleu')) as string;
    expect(text).toBe('Le Hamac Bleu\nLocation: Gustavia, BL');
    // A query with exactly the business's text is at distance 0: the semantic ranker finds it.
    const found = await owner.get(`/v1/businesses?q=${encodeURIComponent(text)}`).expect(200);
    expect(found.body.items.map((i: { id: string }) => i.id)).toContain(id);
    // Nothing changed: nothing is stale, so no new job would be queued.
    expect(await t.app.get(BusinessEmbedder).staleOf([id])).toEqual([]);
  });

  it('re-embeds vectors of another model with the backfill, and is a no-op when re-run', async () => {
    const [business] = await db.select({ id: businesses.id }).from(businesses).limit(1);
    const id = business?.id as string;
    await db.execute(sql`UPDATE businesses SET embedding_model = 'old:model' WHERE id = ${id}`);
    const embedder = t.app.get(BusinessEmbedder);
    expect((await embedder.staleOf([id])).map((s) => s.id)).toEqual([id]);
    const first = await embedder.reindex({ batchSize: 50 });
    expect(first.embedded).toBeGreaterThanOrEqual(1);
    expect((await embeddingOf(id))?.model).toBe(t.app.get(APP_ENV).AI_EMBEDDING_MODEL);
    expect((await embedder.reindex({ batchSize: 50 })).embedded).toBe(0);
  });
});
