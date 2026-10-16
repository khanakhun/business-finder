import { createHash } from 'node:crypto';
import type { ModelFactory } from '@bf/ai';
import { type DbClient, runInTransaction } from '@bf/db';
import { auditLogs, categories, categoryMappings } from '@bf/db/schema';
import { loadTaxonomy, seedTaxonomy } from '@bf/db/seed';
import { MockEmbeddingModelV4 } from 'ai/test';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import {
  type Browser,
  createWorkspace,
  inviteAndJoin,
  signUpVerified,
} from '../../../test/identity-helpers.ts';
import { AI_MODEL_FACTORY } from '../platform/ai/ai.module.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { CategoryCandidateSearch } from './application/taxonomy/category-candidates.ts';
import { CategoryClassifier } from './application/taxonomy/category-classifier.ts';
import { CategoryEmbedder } from './application/taxonomy/category-embedder.ts';
import { normalizeText } from './domain/taxonomy/text-match.ts';

/** Bag-of-words vectors: texts sharing words are close, so vector search is testable without a model. */
function wordVector(text: string): number[] {
  const vector = new Array<number>(1536).fill(0);
  for (const word of normalizeText(text)
    .split(' ')
    .filter((w) => w.length > 2)) {
    const index = createHash('sha256').update(word).digest().readUInt16BE(0) % 1536;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

let embedCalls = 0;
const models: ModelFactory = {
  language: () => {
    throw new Error('no language model in taxonomy tests');
  },
  embedding: () =>
    new MockEmbeddingModelV4({
      doEmbed: async ({ values }) => {
        embedCalls++;
        return { embeddings: values.map((v) => wordVector(String(v))), warnings: [] };
      },
    }),
};

const mailer = new FakeMailer();
let t: TestApp;
let db: DbClient;
let operator: Browser;
let owner: Browser;
let viewer: Browser;
const categoryId = async (slug: string) =>
  (await db.select({ id: categories.id }).from(categories).where(eq(categories.slug, slug)))[0]?.id as string;

beforeAll(async () => {
  t = await createTestApp({
    mailer,
    valkeyDb: 13,
    overrides: [{ token: AI_MODEL_FACTORY, value: models }],
    env: {
      OPENAI_API_KEY: 'sk-test-openai-key-for-taxonomy-tests-00',
      PLATFORM_OPERATOR_EMAILS: 'ops@tax.test',
    },
  });
  db = t.app.get(DB_CLIENT);
  await runInTransaction(db, (tx) => seedTaxonomy(tx, loadTaxonomy()));
  operator = await signUpVerified(t, mailer, 'ops@tax.test', 'Ops Person');
  await createWorkspace(operator, 'Operators');
  owner = await signUpVerified(t, mailer, 'owner@tax.test', 'Olive Owner');
  await createWorkspace(owner, 'Agence');
  viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@tax.test', 'viewer')).client;
});

afterAll(async () => {
  await t?.close();
});

describe('GET /v1/categories', () => {
  it('returns the tree with labels in the requested locale', async () => {
    const res = await viewer.get('/v1/categories?locale=fr').expect(200);
    expect(res.body.version).toBe(1);
    expect(res.body.items.length).toBeGreaterThanOrEqual(14);
    const all: Array<{ slug: string; label: string; children: unknown[] }> = [];
    const walk = (nodes: Array<{ slug: string; label: string; children: never[] }>) => {
      for (const node of nodes) {
        all.push(node);
        walk(node.children);
      }
    };
    walk(res.body.items);
    expect(all.find((n) => n.slug === 'hardware_store')?.label).toBe('Quincaillerie');
    expect(all.length).toBeGreaterThanOrEqual(250);
    await t.http.get('/v1/categories').expect(401);
  });
});

describe('GET /v1/categories/search', () => {
  it.each([
    ['quincaillerie', 'fr', 'hardware_store'],
    ['coiffeur', 'fr', 'hair_salon'],
    ['quincailerie', 'fr', 'hardware_store'],
    ['hair salon', 'en', 'hair_salon'],
    ['plomb', 'fr', 'plumber'],
  ])('%s (%s) → %s', async (q, locale, slug) => {
    const res = await viewer
      .get(`/v1/categories/search?q=${encodeURIComponent(q)}&locale=${locale}`)
      .expect(200);
    expect(res.body.items.slice(0, 3).map((i: { slug: string }) => i.slug)).toContain(slug);
    expect(res.body.items[0]).toMatchObject({ breadcrumb: expect.any(Array), label: expect.any(String) });
  });

  it('validates the query', async () => {
    await viewer.get('/v1/categories/search?q=').expect(422);
  });
});

describe('category mappings review', () => {
  let mappingId: string;

  beforeAll(async () => {
    const [row] = await db
      .insert(categoryMappings)
      .values({
        provider: 'google_places',
        providerKey: 'fake_learned_key',
        providerLabel: 'Learned',
        categoryId: await categoryId('pharmacy'),
        confidence: 0.8,
        origin: 'llm',
        status: 'needs_review',
        rationale: 'Sells medicine.',
      })
      .returning({ id: categoryMappings.id });
    mappingId = row?.id as string;
  });

  it('lists proposals for settings:manage; only operators may review them', async () => {
    const page = await owner.get('/v1/categories/mappings').expect(200);
    expect(page.body).toMatchObject({ canReview: false, nextCursor: null });
    expect(page.body.items).toEqual([
      expect.objectContaining({
        id: mappingId,
        categorySlug: 'pharmacy',
        origin: 'llm',
        status: 'needs_review',
        // The rationale may quote another workspace's business: operators only.
        rationale: null,
      }),
    ]);
    await viewer.get('/v1/categories/mappings').expect(403);
    await owner.patch(`/v1/categories/mappings/${mappingId}`, { action: 'approve' }).expect(403);
    const operatorPage = await operator.get('/v1/categories/mappings').expect(200);
    expect(operatorPage.body).toMatchObject({ canReview: true, items: [{ rationale: 'Sells medicine.' }] });
  });

  it('approves, reassigns and rejects as human decisions, audited', async () => {
    const approved = await operator
      .patch(`/v1/categories/mappings/${mappingId}`, { action: 'approve' })
      .expect(200);
    expect(approved.body).toMatchObject({
      status: 'active',
      origin: 'human',
      categorySlug: 'pharmacy',
      confidence: 1,
    });
    await operator.patch(`/v1/categories/mappings/${mappingId}`, { action: 'reassign' }).expect(422);
    await operator
      .patch(`/v1/categories/mappings/${mappingId}`, {
        action: 'reassign',
        categoryId: '019a0000-0000-7000-8000-000000000000',
      })
      .expect(422);
    const reassigned = await operator
      .patch(`/v1/categories/mappings/${mappingId}?locale=fr`, {
        action: 'reassign',
        categoryId: await categoryId('hardware_store'),
      })
      .expect(200);
    expect(reassigned.body).toMatchObject({ categorySlug: 'hardware_store', categoryLabel: 'Quincaillerie' });
    const rejected = await operator
      .patch(`/v1/categories/mappings/${mappingId}`, { action: 'reject' })
      .expect(200);
    expect(rejected.body.status).toBe('rejected');
    await operator
      .patch(`/v1/categories/mappings/019a0000-0000-7000-8000-000000000000`, { action: 'reject' })
      .expect(404);
    const audit = await db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'taxonomy.mapping_reviewed'), eq(auditLogs.entityId, mappingId)));
    expect(audit.map((a) => (a.metadata as { action: string }).action)).toEqual([
      'approve',
      'reassign',
      'reject',
    ]);
  });

  it('a re-seed never overwrites the human decision', async () => {
    await runInTransaction(db, (tx) => seedTaxonomy(tx, loadTaxonomy()));
    const [row] = await db.select().from(categoryMappings).where(eq(categoryMappings.id, mappingId));
    expect(row).toMatchObject({ origin: 'human', status: 'rejected' });
  });
});

describe('classifier, embeddings and candidates', () => {
  it('classifies with seeded mappings and synonyms', async () => {
    const classifier = t.app.get(CategoryClassifier);
    const mapped = await classifier.classify({
      providerCategories: [{ provider: 'google_places', key: 'hair_salon' }],
      name: 'Studio K',
      locale: 'fr',
    });
    expect(mapped).toMatchObject({ primary: 'hair_salon', origin: 'mapping', needsReview: false });
    const named = await classifier.classify({
      providerCategories: [],
      name: 'Quincaillerie du Port',
      locale: 'fr',
    });
    expect(named).toMatchObject({ primary: 'hardware_store', origin: 'synonym', needsReview: false });
  });

  it('embeds categories once, re-embeds only changed ones, and fuses vector + trigram candidates', async () => {
    const embedder = t.app.get(CategoryEmbedder);
    const first = await embedder.embedPending();
    expect(first.embedded).toBeGreaterThanOrEqual(250);
    expect(await embedder.embedPending()).toMatchObject({ embedded: 0 });
    await db
      .update(categories)
      .set({ synonyms: { en: ['ironmonger', 'tool shop'], fr: ['droguerie'] } })
      .where(eq(categories.slug, 'hardware_store'));
    expect(await embedder.embedPending()).toMatchObject({ embedded: 1 });
    const calls = embedCalls;
    const candidates = await t.app
      .get(CategoryCandidateSearch)
      .find('ironmonger tool shop', 5, { orgId: null });
    expect(embedCalls).toBe(calls + 1);
    expect(candidates[0]?.slug).toBe('hardware_store');
  });
});
