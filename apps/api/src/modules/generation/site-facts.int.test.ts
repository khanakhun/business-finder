import {
  type AiGateway,
  type ExtractSiteFactsOutput,
  GenerationExtractSiteFacts,
  type SiteFactCandidate,
} from '@bf/ai';
import type { DbClient } from '@bf/db';
import { businesses, orgBusinesses, siteFactExtractions, websiteSnapshots } from '@bf/db/schema';
import { aBusiness } from '@bf/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import { type Browser, createWorkspace, signUpVerified } from '../../../test/identity-helpers.ts';
import { AI_GATEWAY } from '../platform/ai/ai.module.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { InMemoryObjectStorage } from '../platform/storage/object-storage.ts';
import { GENERATION_ARTIFACTS } from './application/ports.ts';
import { SiteFactExtraction } from './application/site-facts.extraction.ts';

// Owner-site extraction (BF-040) on a real database: the latest crawl's pages from storage, a (stubbed) model whose
// answer mixes true and invented facts, only verified facts stored and then served by the registry, once per content.

const store = new InMemoryObjectStorage();
const artifacts = {
  put: (key: string, body: Buffer, type: string) => store.put(key, body, type),
  get: async (key: string) => (await store.get(key))?.body,
};

const blank = (overrides: Partial<SiteFactCandidate>): SiteFactCandidate => ({
  kind: 'service',
  pageId: 'p1',
  locale: 'fr',
  evidence: '',
  text: null,
  price: null,
  hours: null,
  testimonial: null,
  person: null,
  year: null,
  booking: null,
  ...overrides,
});

const answer: ExtractSiteFactsOutput = {
  candidates: [
    blank({ kind: 'service', text: 'Coupe femme', evidence: 'Coupe femme — 45 €' }),
    blank({
      kind: 'price',
      evidence: 'Coupe femme — 45 €',
      price: { amount: 45, currency: 'EUR', unit: null, item: 'Coupe femme' },
    }),
    blank({ kind: 'phone', pageId: 'p2', text: '05 90 00 00 07', evidence: 'Tél. 05 90 00 00 07' }),
    blank({
      kind: 'hours',
      pageId: 'p2',
      evidence: 'Du mardi au samedi, 9h–18h',
      hours: ['tue', 'wed', 'thu', 'fri', 'sat'].map((day) => ({
        day: day as 'tue',
        opens: '09:00',
        closes: '18:00',
      })),
    }),
    // Invented: a service nobody offers, a price changed, a testimonial not on the page.
    blank({ kind: 'service', text: 'Massage aux pierres chaudes', evidence: 'Massage aux pierres chaudes' }),
    blank({
      kind: 'price',
      evidence: 'Coupe femme — 45 €',
      price: { amount: 55, currency: 'EUR', unit: null, item: 'Coupe femme' },
    }),
    blank({
      kind: 'testimonial',
      evidence: 'Coupe femme — 45 €',
      testimonial: { quote: 'Le meilleur salon de l’île', attribution: 'Claire' },
    }),
  ],
  warnings: [],
};

const calls: { orgId: string | null; input: unknown }[] = [];
const gateway = {
  async run(task: { name: string }, input: unknown, ctx: { orgId: string | null }) {
    if (task.name !== GenerationExtractSiteFacts.name) throw new Error(`unexpected task ${task.name}`);
    calls.push({ orgId: ctx.orgId, input });
    return {
      output: answer,
      provider: 'anthropic',
      model: 'stub-smart',
      promptVersion: 1,
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      costUsd: 0,
      cached: false,
      latencyMs: 1,
    };
  },
} as unknown as AiGateway;

const mailer = new FakeMailer();
let t: TestApp;
let db: DbClient;
let member: Browser;
let org: string;
let businessId: string;

beforeAll(async () => {
  t = await createTestApp({
    mailer,
    valkeyDb: 25,
    overrides: [
      { token: AI_GATEWAY, value: gateway },
      { token: GENERATION_ARTIFACTS, value: artifacts },
    ],
  });
  db = t.app.get(DB_CLIENT);
  member = await signUpVerified(t, mailer, 'member@sitefacts.test', 'Sacha Site');
  org = await createWorkspace(member, 'Agence Sites');
  const business = aBusiness({ displayName: 'Salon Corail', locality: 'Gustavia', countryCode: 'BL' });
  businessId = business.id;
  await db.insert(businesses).values(business);
  await db.insert(orgBusinesses).values({ organizationId: org, businessId, addedVia: 'search' });
  await store.put(
    `crawl/${businessId}/pages/00-home.md`,
    Buffer.from('# Salon Corail\n\nNos prestations\n\n- Coupe femme — 45 €\n- Brushing — 30 €\n'),
    'text/markdown',
  );
  await store.put(
    `crawl/${businessId}/pages/01-contact.md`,
    Buffer.from('# Contact\n\nTél. 05 90 00 00 07\n\nDu mardi au samedi, 9h–18h\n'),
    'text/markdown',
  );
  const empty = {} as never;
  await db.insert(websiteSnapshots).values({
    businessId,
    url: 'https://salon-corail.example/',
    fetchedAt: new Date('2026-10-12T08:00:00Z'),
    reachability: 'ok',
    tls: empty,
    security: empty,
    languages: empty,
    pages: [
      {
        url: 'https://salon-corail.example/',
        kind: 'home',
        title: 'Salon Corail',
        metaDescription: null,
        lang: 'fr',
        h1: 'Salon Corail',
        wordCount: 12,
        markdownKey: `crawl/${businessId}/pages/00-home.md`,
      },
      {
        url: 'https://salon-corail.example/contact',
        kind: 'contact',
        title: 'Contact',
        metaDescription: null,
        lang: 'fr',
        h1: 'Contact',
        wordCount: 8,
        markdownKey: `crawl/${businessId}/pages/01-contact.md`,
      },
      {
        url: 'https://salon-corail.example/mentions',
        kind: 'legal',
        title: 'Mentions',
        metaDescription: null,
        lang: 'fr',
        h1: null,
        wordCount: 3,
        markdownKey: null,
      },
    ],
    contacts: empty,
    socials: [],
    booking: empty,
    ordering: empty,
    chat: empty,
    analytics: empty,
    tech: [],
    freshness: empty,
    mobile: empty,
    performanceHints: empty,
    links: empty,
    noSolicitation: empty,
    logoCandidates: [],
    imageCandidates: [],
    warnings: [],
    contentHash: 'test',
  });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('owner-site fact extraction (BF-040)', () => {
  it('stores only verified facts, once per content, and the registry serves them as owner-site facts', async () => {
    const extraction = t.app.get(SiteFactExtraction);
    const outcome = await extraction.extract(org, businessId);
    expect(outcome).toMatchObject({
      status: 'extracted',
      stats: {
        pages: 2,
        candidates: 7,
        accepted: 4,
        rejected: { evidence_not_on_page: 1, number_not_in_evidence: 1, quote_not_on_page: 1 },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.orgId).toBe(org);

    expect((await extraction.extract(org, businessId)).status).toBe('cached');
    expect(calls).toHaveLength(1);
    expect(
      await db.select().from(siteFactExtractions).where(eq(siteFactExtractions.businessId, businessId)),
    ).toHaveLength(1);

    const { body } = await member.get(`/v1/businesses/${businessId}/facts`).expect(200);
    const owner = (
      body.facts as {
        kind: string;
        value: unknown;
        source: string;
        usage: string;
        evidence?: string;
        sourceRef: string;
      }[]
    ).filter((fact) => fact.source === 'owner_site');
    expect(owner.map((fact) => [fact.kind, fact.value, fact.usage])).toEqual(
      expect.arrayContaining([
        ['service', 'Coupe femme', 'display'],
        ['price', { amount: 45, currency: 'EUR', serviceRef: 'Coupe femme' }, 'display'],
        ['phone', '+590590000007', 'display'],
      ]),
    );
    expect(owner.find((fact) => fact.kind === 'hours')?.sourceRef).toBe(
      'https://salon-corail.example/contact',
    );
    expect(owner.find((fact) => fact.kind === 'service')?.evidence).toBe('Coupe femme — 45 €');
    expect(owner.some((fact) => JSON.stringify(fact.value).includes('Massage'))).toBe(false);
  });
});
