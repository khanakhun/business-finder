import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AiGateway, SitePlanInput } from '@bf/ai';
import type { RunnerFrame, RunnerInput } from '@bf/contracts/runner';
import type { DbClient } from '@bf/db';
import {
  businessContacts,
  businesses,
  generationAttempts,
  generationEvents,
  generationJobs,
  orgBusinesses,
} from '@bf/db/schema';
import { QUEUES } from '@bf/queue';
import { aBusiness, aContact } from '@bf/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestWorker, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import { type Browser, createWorkspace, signUpVerified } from '../../../test/identity-helpers.ts';
import { AI_GATEWAY } from '../platform/ai/ai.module.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { InMemoryObjectStorage } from '../platform/storage/object-storage.ts';
import { GENERATION_ARTIFACTS } from './application/ports.ts';
import { SANDBOX_JANITOR, SANDBOX_PROVIDER, type SandboxProvider } from './application/sandbox.ports.ts';
import { GENERATION_REAPER_AUTOSTART } from './infrastructure/bullmq-generation-queues.ts';
import { unpackBundle } from './infrastructure/workspace/tar.ts';

// The Claude Code engine through the orchestrator (BF-044): a batch with engine `claude-code`, the workspace built
// from the business's facts (BF-040), the run in a scripted sandbox that answers with Claude Code's stream format and
// the site it "wrote", validated outside the sandbox, published; and an agent whose site invents an award, rejected
// twice and failed over to the blocks engine.

const ENV = {
  SITES_BASE_DOMAIN: 'sites.test',
  SITES_ASSETS_BASE_URL: 'https://assets.bf-sites.test',
  SANDBOX_ENABLED: 'true',
  GENERATION_CLAUDE_CODE_ENGINE: 'true',
  GENERATION_BLOCKS_ENGINE: 'true',
  GENERATION_FAKE_ENGINE: 'false',
};

const STREAM = readFileSync(
  new URL('./infrastructure/engines/__fixtures__/streams/claude-code/success.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean);

const artifact = (name: string, body: Buffer): RunnerFrame => ({
  t: 'artifact',
  name,
  sha256: createHash('sha256').update(body).digest('hex'),
  bytes: body.length,
  seq: 0,
  last: true,
  data: body.toString('base64'),
});

/** A sandbox that "runs" Claude Code: the success stream, a passing check, the starter site with a new hero line. */
class ScriptedSandbox implements SandboxProvider {
  readonly id = 'scripted';
  readonly inputs: RunnerInput[] = [];
  async ready() {
    return { ready: true };
  }
  async *run(_spec: unknown, input: RunnerInput, bundle: Uint8Array) {
    this.inputs.push(input);
    const files = unpackBundle(Buffer.from(bundle));
    const name = (JSON.parse(files.get('brief.json')?.toString() ?? '{}') as { identity?: { name?: string } })
      .identity?.name;
    const site = JSON.parse(files.get('site.json')?.toString() ?? '{}') as {
      locales: string[];
      pages: { blocks: { type: string; props: Record<string, unknown> }[] }[];
    };
    const hero = site.pages[0]?.blocks.find((block) => block.type === 'hero');
    const line = name?.includes('Prix')
      ? 'Élu meilleur salon des Caraïbes depuis 1987'
      : `${name}, sur le port`;
    if (hero) hero.props.subtitle = Object.fromEntries(site.locales.map((locale) => [locale, line]));
    yield { t: 'versions', protocol: 1, versions: { claude: '2.1.288 (Claude Code)' } } as RunnerFrame;
    for (const text of STREAM) yield { t: 'engine', line: text } as RunnerFrame;
    yield {
      t: 'check',
      exitCode: 0,
      report: { command: 'check', ok: true, exitCode: 0, data: { done: true } },
    } as RunnerFrame;
    yield artifact('site.json', Buffer.from(JSON.stringify(site)));
    yield { t: 'exit', code: 0, reason: 'completed' } as RunnerFrame;
  }
}

/** The blocks engine's model, for the failover. */
const gateway = {
  async run(task: { name: string }, input: unknown) {
    const output =
      task.name === 'generation.site_plan'
        ? {
            pages: (input as SitePlanInput).pages.map((page) => ({
              id: page.id,
              blocks: page.blocks.map((block) => ({ id: block.id, variant: block.variant, intent: 'x' })),
            })),
            heroConcept: 'x',
            warnings: [],
          }
        : { blocks: [], seo: { title: {}, description: {} }, warnings: [] };
    return {
      output,
      provider: 'anthropic',
      model: 'scripted',
      promptVersion: 1,
      usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 0 },
      costUsd: 0.001,
      cached: false,
      latencyMs: 1,
    };
  },
} as unknown as AiGateway;

const sandbox = new ScriptedSandbox();
const store = new InMemoryObjectStorage();
const overrides = [
  {
    token: GENERATION_ARTIFACTS,
    value: {
      put: (key: string, body: Buffer, type: string) => store.put(key, body, type),
      get: async (key: string) => (await store.get(key))?.body,
    },
  },
  { token: AI_GATEWAY, value: gateway },
  { token: SANDBOX_PROVIDER, value: sandbox },
  { token: SANDBOX_JANITOR, value: null },
];

const mailer = new FakeMailer();
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let owner: Browser;
let org: string;

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 30, env: ENV, overrides });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, {
    mailer,
    env: ENV,
    overrides: [...overrides, { token: GENERATION_REAPER_AUTOSTART, value: false }],
  });
  for (const queue of [
    QUEUES.generationClaudeCode.name,
    QUEUES.generationBlocks.name,
    QUEUES.generationQuality.name,
  ])
    await worker.get<Queue>(getQueueToken(queue)).obliterate({ force: true });
  owner = await signUpVerified(t, mailer, 'owner@claude-code.test', 'Olive Owner');
  org = await createWorkspace(owner, 'Agence Agents');
  await owner
    .put('/v1/workspace/secrets/anthropic', { value: 'sk-ant-int-test-000000000000000' })
    .expect(200);
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

async function business(name: string) {
  const row = aBusiness({ displayName: name, locality: 'Gustavia', countryCode: 'BL' });
  await db.insert(businesses).values(row);
  await db.insert(orgBusinesses).values({ organizationId: org, businessId: row.id, addedVia: 'search' });
  await db
    .insert(businessContacts)
    .values(aContact({ businessId: row.id, type: 'phone', value: '+590590000155' }));
  return row.id;
}

/**
 * The job once it reaches `expected` (or the last status seen at the deadline). A failover passes through `failed`
 * on its way back to `queued`, so a first terminal status is not the end.
 */
async function settle(batchId: string, expected: string) {
  const deadline = Date.now() + 90_000;
  let job: typeof generationJobs.$inferSelect | undefined;
  while (Date.now() < deadline) {
    [job] = await db.select().from(generationJobs).where(eq(generationJobs.batchId, batchId));
    if (job?.status === expected) return job;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!job) throw new Error('no job');
  return job;
}

describe('Claude Code engine through the orchestrator (BF-044)', () => {
  it('generates a site in a sandbox with the workspace key, validated and published', async () => {
    const id = await business('Salon Turquoise');
    const { body } = await owner
      .post('/v1/generation-batches', { items: [{ businessId: id, engine: 'claude-code' }] })
      .set('Idempotency-Key', 'batch-claude-1')
      .expect(201);
    const job = await settle(body.id, 'succeeded');
    expect(job).toMatchObject({ status: 'succeeded', engineCurrent: 'claude-code' });
    const input = sandbox.inputs.at(-1);
    expect(input?.command[0]).toBe('claude');
    expect(input?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-int-test-000000000000000');
    expect(input?.secrets).toEqual(['ANTHROPIC_API_KEY']);
    const { body: detail } = await owner.get(`/v1/generation-jobs/${job.id}`).expect(200);
    const { body: site } = await owner.get(`/v1/sites/${detail.siteId}`).expect(200);
    const { body: version } = await owner
      .get(`/v1/sites/${detail.siteId}/versions/${site.currentVersion.id}`)
      .expect(200);
    expect(JSON.stringify(version.spec)).toContain('Salon Turquoise, sur le port');
    // The key never reaches the persisted events.
    const events = await db.select().from(generationEvents).where(eq(generationEvents.jobId, job.id));
    expect(events.length).toBeGreaterThan(5);
    expect(JSON.stringify(events)).not.toContain('sk-ant-int-test');
  }, 120_000);

  it('rejects an invented award twice, then fails over to the blocks engine', async () => {
    const id = await business('Salon Prix');
    const { body } = await owner
      .post('/v1/generation-batches', { items: [{ businessId: id, engine: 'claude-code' }] })
      .set('Idempotency-Key', 'batch-claude-2')
      .expect(201);
    const job = await settle(body.id, 'succeeded');
    const attempts = await db
      .select({ engine: generationAttempts.engine, exitReason: generationAttempts.exitReason })
      .from(generationAttempts)
      .where(eq(generationAttempts.jobId, job.id))
      .orderBy(asc(generationAttempts.attemptNo));
    // The attempts first: on a failure they say why (engine and exit reason of each).
    expect(attempts.map((a) => `${a.engine}:${a.exitReason ?? ''}`)).toEqual([
      'claude-code:ENGINE_INVALID_OUTPUT',
      'claude-code:ENGINE_INVALID_OUTPUT',
      expect.stringMatching(/^blocks:/),
    ]);
    expect(job).toMatchObject({ status: 'succeeded', engineCurrent: 'blocks' });
  }, 120_000);
});
