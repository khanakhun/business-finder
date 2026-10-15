import { type AiGateway, DemoExtractBusinessFacts, type ModelFactory } from '@bf/ai';
import { BudgetExceededError } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { llmCalls, outboxEvents } from '@bf/db/schema';
import { MockLanguageModelV4 } from 'ai/test';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../../test/create-test-app.ts';
import { FakeMailer } from '../../../../test/fake-mailer.ts';
import {
  type Browser,
  createWorkspace,
  inviteAndJoin,
  signUpVerified,
} from '../../../../test/identity-helpers.ts';
import { DB_CLIENT } from '../db/db.module.ts';
import { AI_GATEWAY, AI_MODEL_FACTORY } from './ai.module.ts';

const GLOBAL_KEY = 'sk-ant-global-deployment-key-for-tests-000';
const WORKSPACE_KEY = 'sk-ant-workspace-key-for-tests-0000000000';

let t: TestApp;
let db: DbClient;
let ai: AiGateway;
const mailer = new FakeMailer();
let owner: Browser;
let orgA: string;
let orgB: string;
/** API keys the mock "provider" was called with. */
const keysUsed: string[] = [];

const facts = JSON.stringify({
  phones: ['05 90 00 00 01'],
  emails: [],
  openingHours: null,
  services: ['pain'],
  languages: ['fr'],
  warnings: [],
  confidence: 0.9,
});
const models: ModelFactory = {
  language: (_ref, apiKey) => {
    keysUsed.push(apiKey);
    return new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: facts }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 2000, noCache: 2000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 400, text: 400, reasoning: 0 },
        },
        warnings: [],
      },
    });
  },
  embedding: () => {
    throw new Error('not used');
  },
};
const input = (n: number) => ({
  businessName: `Boulangerie ${n}`,
  websiteUrl: `https://b${n}.example.test`,
  pageText: `Boulangerie ${n}. Tél. 05 90 00 00 01.`,
});

beforeAll(async () => {
  t = await createTestApp({
    mailer,
    valkeyDb: 11,
    overrides: [{ token: AI_MODEL_FACTORY, value: models }],
    env: {
      ANTHROPIC_API_KEY: GLOBAL_KEY,
      // 2000 input + 400 output tokens at $1 / $5 per million = $0.004 per call.
      AI_PRICING: JSON.stringify({ 'claude-haiku-5-5': { inputPerMTok: 1, outputPerMTok: 5 } }),
      AI_BUDGET_MONTHLY_SOFT_USD: '0.006',
      AI_BUDGET_MONTHLY_HARD_USD: '0.011',
    },
  });
  await new Redis(t.env.VALKEY_URL).flushdb();
  db = t.app.get(DB_CLIENT);
  ai = t.app.get(AI_GATEWAY);
  owner = await signUpVerified(t, mailer, 'owner@ai.test', 'Olive Owner');
  orgA = await createWorkspace(owner, 'AI Co');
  await owner.put('/v1/workspace/secrets/anthropic', { value: WORKSPACE_KEY }).expect(200);
  const other = await signUpVerified(t, mailer, 'other@ai.test', 'Other');
  orgB = await createWorkspace(other, 'No Key Co');
});

afterAll(async () => {
  await t?.close();
});

describe('AI gateway in the API', () => {
  it('uses the workspace key first, else the deployment key, and records every call', async () => {
    await ai.run(DemoExtractBusinessFacts, input(1), { orgId: orgA });
    await ai.run(DemoExtractBusinessFacts, input(2), { orgId: orgB });
    expect(keysUsed).toEqual([WORKSPACE_KEY, GLOBAL_KEY]);
    const rows = await db.select().from(llmCalls).where(eq(llmCalls.organizationId, orgA));
    expect(rows).toEqual([
      expect.objectContaining({
        task: 'demo.extract_business_facts',
        promptVersion: 1,
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        inputTokens: 2000,
        outputTokens: 400,
        costUsd: 0.004,
        status: 'ok',
      }),
    ]);
  });

  it('serves identical public inputs from the cache (recorded as cached, free)', async () => {
    const result = await ai.run(DemoExtractBusinessFacts, input(1), { orgId: orgB });
    expect(result.cached).toBe(true);
    const cached = await db.select().from(llmCalls).where(eq(llmCalls.status, 'cached'));
    expect(cached).toHaveLength(1);
  });

  it('reports usage by task, model and day to owners only', async () => {
    await ai.run(DemoExtractBusinessFacts, input(3), { orgId: orgA });
    // The test app's clock is fixed in the past: ask for an explicit window around the real calls.
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const usage = await owner.get(`/v1/ai/usage?from=${from}&to=${to}`).expect(200);
    expect(usage.body.totals).toMatchObject({ calls: 2, errors: 0, inputTokens: 4000, outputTokens: 800 });
    expect(usage.body.totals.costUsd).toBeCloseTo(0.008);
    expect(usage.body.byTask).toEqual([
      expect.objectContaining({ task: 'demo.extract_business_facts', calls: 2 }),
    ]);
    expect(usage.body.byModel).toEqual([
      expect.objectContaining({ provider: 'anthropic', model: 'claude-haiku-5-5' }),
    ]);
    expect(usage.body.byDay).toHaveLength(1);
    expect(usage.body.budget).toMatchObject({ softUsd: 0.006, hardUsd: 0.011 });
    const viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@ai.test', 'viewer')).client;
    await viewer.get('/v1/ai/usage').expect(403);
  });
});

describe('budgets', () => {
  it('warns once at the soft limit, then blocks non-essential tasks at the hard limit', async () => {
    const { LedgerBudgetGuard, softBudgetNotifier } = await import('./ai-adapters.ts');
    const { LlmCallRepository } = await import('./llm-call.repository.ts');
    const { EventRecorder } = await import('../events/event-recorder.ts');
    const { createAiGateway } = await import('@bf/ai');
    const ledger = t.app.get(LlmCallRepository);
    const clock = { now: () => new Date() };
    // No spend cache, so each call sees the previous one.
    const guard = new LedgerBudgetGuard(ledger, { softUsd: 0.006, hardUsd: 0.011 }, clock, 0);
    const gateway = createAiGateway({
      routing: {
        tiers: { fast: 'claude-haiku-5-5', smart: 'claude-haiku-5-5', agent: 'claude-haiku-5-5' },
        embeddingModel: 'openai:x',
      },
      keys: { resolve: async () => 'k' },
      pricing: { 'claude-haiku-5-5': { inputPerMTok: 1, outputPerMTok: 5 } },
      recorder: ledger,
      budget: guard,
      onSoftBudget: softBudgetNotifier({
        valkey: new Redis(t.env.VALKEY_URL),
        events: t.app.get(EventRecorder),
        budget: guard,
        softUsd: 0.006,
        clock,
        logger: { warn: () => undefined } as never,
      }),
      models,
    });
    const softEvents = async () =>
      (await db.select().from(outboxEvents).where(eq(outboxEvents.type, 'ai.budget_soft_limit_reached')))
        .length;
    // orgA has spent $0.008 (two priced calls): soft.
    await gateway.run(DemoExtractBusinessFacts, input(10), { orgId: orgA });
    await gateway.run(DemoExtractBusinessFacts, input(11), { orgId: orgA }).catch(() => undefined);
    await expect.poll(softEvents).toBe(1);
    // Now $0.012 ≥ $0.011: hard.
    expect(await guard.check(orgA)).toBe('hard');
    await expect(gateway.run(DemoExtractBusinessFacts, input(12), { orgId: orgA })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(await guard.check(orgB)).toBe('ok');
    expect(await softEvents()).toBe(1);
  });
});
