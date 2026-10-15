import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetExceededError } from '@bf/contracts';
import { APICallError } from 'ai';
import { convertArrayToReadableStream, MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test';
import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTask } from './define-task.ts';
import { AiOutputInvalidError, AiProviderNotConfiguredError, AiProviderUnavailableError } from './errors.ts';
import { type AiGatewayOptions, createAiGateway, type ModelFactory } from './gateway.ts';
import type { AiCache, LlmCall } from './ports.ts';
import { type PromptRegistry, parsePrompt } from './prompts/registry.ts';
import { createFakeAiGateway, MissingFixtureError } from './testing/fake-gateway.ts';

// --- fixtures ---------------------------------------------------------------------------------------------------

const promptFile = (task: string) => `---
task: ${task}
version: 1
tier: fast
changelog: "test"
---
# System
Extract.

# User
{{text}}`;

const TASKS = ['gw.extract', 'gw.essential', 'gw.write', 'gw.look'];
const prompts: PromptRegistry = {
  get: (id) => parsePrompt(`${id}.md`, promptFile(id.replace(/\.v1$/, ''))),
  ids: () => TASKS.map((t) => `${t}.v1`),
};

const Extract = defineTask({
  name: 'gw.extract',
  kind: 'object',
  tier: 'fast',
  prompt: 'gw.extract.v1',
  input: z.object({ text: z.string() }),
  output: z.object({ city: z.string() }),
  maxOutputTokens: 100,
  timeoutMs: 5_000,
  cacheTtlSeconds: 60,
});
const Essential = defineTask({
  ...Extract,
  name: 'gw.essential',
  prompt: 'gw.essential.v1',
  essential: true,
});
const Write = defineTask({
  name: 'gw.write',
  kind: 'text',
  tier: 'smart',
  prompt: 'gw.write.v1',
  input: z.object({ text: z.string() }),
  maxOutputTokens: 100,
  timeoutMs: 5_000,
});
const Look = defineTask({
  name: 'gw.look',
  kind: 'vision',
  tier: 'smart',
  prompt: 'gw.look.v1',
  input: z.object({ text: z.string() }),
  output: z.object({ score: z.number() }),
  maxOutputTokens: 100,
  timeoutMs: 5_000,
  maxImageDimension: 800,
});

const usage = (input: number, output: number, cached = 0) => ({
  inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});
const answer = (text: string, input = 100, output = 20, cached = 0) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage: usage(input, output, cached),
  warnings: [],
});
const outage = () =>
  new APICallError({
    message: 'overloaded',
    url: 'https://api.test',
    requestBodyValues: {},
    statusCode: 529,
    isRetryable: true,
  });

class MemoryCache implements AiCache {
  readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key);
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
  }
}

function setup(
  overrides: Partial<AiGatewayOptions> = {},
  models: Partial<Record<string, MockLanguageModelV4>> = {},
) {
  const calls: LlmCall[] = [];
  const embedding = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: 100,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((v) => [v.length, 1]),
      usage: { tokens: values.length * 3 },
      warnings: [],
    }),
  });
  const factory: ModelFactory = {
    language: (ref) => {
      const model = models[`${ref.provider}:${ref.model}`];
      if (!model) throw new Error(`no mock for ${ref.provider}:${ref.model}`);
      return model;
    },
    embedding: () => embedding,
  };
  const cache = new MemoryCache();
  const gateway = createAiGateway({
    routing: {
      tiers: { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5', agent: 'claude-opus-5-5' },
      fallbacks: { 'claude-haiku-5-5': ['openai:gpt-5-mini'] },
      embeddingModel: 'openai:text-embedding-3-small',
    },
    keys: { resolve: async (_org, provider) => `key-${provider}` },
    prompts,
    pricing: { 'claude-haiku-5-5': { inputPerMTok: 1, outputPerMTok: 5 } },
    cache,
    recorder: { record: async (call) => void calls.push(call) },
    models: factory,
    resilience: {
      maxRetries: 1,
      initialDelayMs: 1,
      maxDelayMs: 2,
      breakerThreshold: 3,
      halfOpenAfterMs: 60_000,
    },
    embeddingBatchSize: 2,
    ...overrides,
  });
  return { gateway, calls, cache, embedding };
}

const ctx = { orgId: '01990000-0000-7000-8000-000000000001' };

// --- tests ------------------------------------------------------------------------------------------------------

describe('structured output', () => {
  it('returns typed output, records cost and caches the answer', async () => {
    const haiku = new MockLanguageModelV4({ doGenerate: answer('{"city":"Gustavia"}', 1000, 200, 100) });
    const { gateway, calls, cache } = setup({}, { 'anthropic:claude-haiku-5-5': haiku });
    const first = await gateway.run(Extract, { text: 'Gustavia' }, ctx);
    expect(first).toMatchObject({
      output: { city: 'Gustavia' },
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      cached: false,
    });
    expect(first.usage).toEqual({ inputTokens: 1000, outputTokens: 200, cachedTokens: 100 });
    expect(first.costUsd).toBe(0.002);
    expect(cache.values.size).toBe(1);

    const second = await gateway.run(Extract, { text: 'Gustavia' }, ctx);
    expect(second).toMatchObject({ output: { city: 'Gustavia' }, cached: true, costUsd: 0 });
    expect(haiku.doGenerateCalls).toHaveLength(1);
    expect(calls.map((c) => c.status)).toEqual(['ok', 'cached']);
    expect(calls[0]).toMatchObject({
      task: 'gw.extract',
      promptVersion: 1,
      orgId: ctx.orgId,
      inputTokens: 1000,
    });
  });

  it('repairs an invalid answer once, sending the validation error back', async () => {
    const haiku = new MockLanguageModelV4({
      doGenerate: [answer('{"town":"Gustavia"}', 50, 10), answer('{"city":"Gustavia"}', 70, 10)],
    });
    const { gateway } = setup({}, { 'anthropic:claude-haiku-5-5': haiku });
    const result = await gateway.run(Extract, { text: 'x' }, ctx);
    expect(result.output).toEqual({ city: 'Gustavia' });
    expect(result.usage.inputTokens).toBe(120);
    const repairPrompt = JSON.stringify(haiku.doGenerateCalls[1]?.prompt);
    expect(repairPrompt).toContain('did not match the required JSON schema');
  });

  it('fails with AiOutputInvalidError after a failed repair, and records the error', async () => {
    const haiku = new MockLanguageModelV4({ doGenerate: [answer('not json'), answer('still not json')] });
    const { gateway, calls } = setup({}, { 'anthropic:claude-haiku-5-5': haiku });
    await expect(gateway.run(Extract, { text: 'y' }, ctx)).rejects.toBeInstanceOf(AiOutputInvalidError);
    // The tokens of both failed attempts were billed: they are recorded (and priced).
    expect(calls.at(-1)).toMatchObject({
      status: 'error',
      errorCode: 'AI_OUTPUT_INVALID',
      inputTokens: 200,
      outputTokens: 40,
      costUsd: 0.0004,
    });
  });
});

describe('resilience', () => {
  it('retries transient errors, then falls back to the next model', async () => {
    const haiku = new MockLanguageModelV4({
      doGenerate: async () => {
        throw outage();
      },
    });
    const mini = new MockLanguageModelV4({ doGenerate: answer('{"city":"Lorient"}') });
    const onUnpricedModel = vi.fn();
    const { gateway, calls } = setup(
      { onUnpricedModel },
      { 'anthropic:claude-haiku-5-5': haiku, 'openai:gpt-5-mini': mini },
    );
    const result = await gateway.run(Extract, { text: 'z' }, ctx);
    expect(result).toMatchObject({ provider: 'openai', model: 'gpt-5-mini', output: { city: 'Lorient' } });
    expect(haiku.doGenerateCalls).toHaveLength(2); // first attempt + one retry
    expect(calls.at(-1)).toMatchObject({ status: 'ok', model: 'gpt-5-mini', costUsd: null });
    expect(onUnpricedModel).toHaveBeenCalledWith('gpt-5-mini');
    await gateway.run(Extract, { text: 'z2' }, ctx);
    expect(onUnpricedModel).toHaveBeenCalledTimes(1);
  });

  it('reports unavailability when every model fails', async () => {
    const failing = () =>
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw outage();
        },
      });
    const { gateway } = setup(
      {},
      { 'anthropic:claude-haiku-5-5': failing(), 'openai:gpt-5-mini': failing() },
    );
    await expect(gateway.run(Extract, { text: 'w' }, ctx)).rejects.toBeInstanceOf(AiProviderUnavailableError);
  });

  it('names the secret to set when no provider is configured', async () => {
    const { gateway, calls } = setup({ keys: { resolve: async () => undefined } });
    const error = await gateway.run(Extract, { text: 'v' }, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderNotConfiguredError);
    expect((error as AiProviderNotConfiguredError).secretName).toBe('anthropic');
    expect(calls.at(-1)?.errorCode).toBe('AI_PROVIDER_NOT_CONFIGURED');
  });
});

describe('budgets', () => {
  it('blocks non-essential tasks past the hard limit and warns at the soft limit', async () => {
    const haiku = new MockLanguageModelV4({ doGenerate: answer('{"city":"A"}') });
    const onSoftBudget = vi.fn();
    const hard = setup(
      { budget: { check: async () => 'hard' }, onSoftBudget },
      { 'anthropic:claude-haiku-5-5': haiku },
    );
    await expect(hard.gateway.run(Extract, { text: 'b1' }, ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(hard.gateway.run(Essential, { text: 'b1' }, ctx)).resolves.toMatchObject({
      output: { city: 'A' },
    });
    const soft = setup(
      { budget: { check: async () => 'soft' }, onSoftBudget },
      { 'anthropic:claude-haiku-5-5': haiku },
    );
    await soft.gateway.run(Extract, { text: 'b2' }, ctx);
    expect(onSoftBudget).toHaveBeenCalledWith(ctx.orgId, 'gw.extract');
  });
});

describe('text, streaming, vision, embeddings', () => {
  it('generates and streams text', async () => {
    const sonnet = new MockLanguageModelV4({
      doGenerate: answer('Bonjour'),
      doStream: {
        stream: convertArrayToReadableStream([
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'Bon' },
          { type: 'text-delta', id: 't', delta: 'jour' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: usage(10, 2) },
        ]),
      },
    });
    const { gateway, calls } = setup({}, { 'anthropic:claude-sonnet-5-5': sonnet });
    expect((await gateway.run(Write, { text: 'hi' }, ctx)).output).toBe('Bonjour');
    const stream = await gateway.stream(Write, { text: 'hi' }, ctx);
    let text = '';
    for await (const chunk of stream.textStream) text += chunk;
    expect(text).toBe('Bonjour');
    expect((await stream.result).usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    expect(calls.map((c) => c.status)).toEqual(['ok', 'ok']);
  });

  it('resizes image bytes before a vision call', async () => {
    const sonnet = new MockLanguageModelV4({ doGenerate: answer('{"score":7}') });
    const { gateway } = setup({}, { 'anthropic:claude-sonnet-5-5': sonnet });
    const big = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#0f766e' } })
      .png()
      .toBuffer();
    const result = await gateway.vision(Look, { input: { text: 'rate' }, images: [{ bytes: big }] }, ctx);
    expect(result.output).toEqual({ score: 7 });
    const content = (sonnet.doGenerateCalls[0]?.prompt.find((m) => m.role === 'user')?.content ??
      []) as Array<{
      type: string;
      data?: { type: string; data: Uint8Array };
      mediaType?: string;
    }>;
    const file = content.find((part) => part.type === 'file');
    expect(file?.mediaType).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(file?.data?.data ?? new Uint8Array())).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(800);
  });

  it('passes image URLs to the provider (https only, never downloaded here) and caps image counts', async () => {
    const sonnet = new MockLanguageModelV4({ doGenerate: answer('{"score":5}') });
    const { gateway } = setup({}, { 'anthropic:claude-sonnet-5-5': sonnet });
    await gateway.vision(
      Look,
      { input: { text: 'rate' }, images: [{ url: 'https://shots.example.test/a.png' }] },
      ctx,
    );
    const content = JSON.stringify(sonnet.doGenerateCalls[0]?.prompt);
    expect(content).toContain('https://shots.example.test/a.png');
    expect(content).toContain('image/*');
    await expect(
      gateway.vision(Look, { input: { text: 'x' }, images: [{ url: 'http://169.254.169.254/latest' }] }, ctx),
    ).rejects.toThrow(/https/);
    await expect(
      gateway.vision(
        Look,
        { input: { text: 'x' }, images: [{ url: 'https://user:pass@shots.example.test/a.png' }] },
        ctx,
      ),
    ).rejects.toThrow(/credentials/);
    const many = Array.from({ length: 9 }, (_, i) => ({ url: `https://shots.example.test/${i}.png` }));
    await expect(gateway.vision(Look, { input: { text: 'x' }, images: many }, ctx)).rejects.toThrow(
      /At most 8/,
    );
  });

  it('embeds in batches and serves repeated texts from the cache', async () => {
    const { gateway, embedding, calls } = setup();
    const first = await gateway.embed(['a', 'bb', 'ccc'], { purpose: 'test', orgId: null });
    expect(first).toEqual({
      vectors: [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      model: 'text-embedding-3-small',
      dims: 2,
    });
    expect(embedding.doEmbedCalls.map((c) => c.values)).toEqual([['a', 'bb'], ['ccc']]);
    await gateway.embed(['bb', 'dddd'], { purpose: 'test', orgId: null });
    expect(embedding.doEmbedCalls.at(-1)?.values).toEqual(['dddd']);
    expect(calls.map((c) => [c.task, c.inputTokens])).toEqual([
      ['embed.test', 9],
      ['embed.test', 3],
    ]);
  });
});

describe('fake gateway (record/replay)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-ai-fixtures-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('records real answers, then replays them without a model', async () => {
    const haiku = new MockLanguageModelV4({ doGenerate: answer('{"city":"Saint-Jean"}') });
    const { gateway } = setup({}, { 'anthropic:claude-haiku-5-5': haiku });
    const recorder = createFakeAiGateway({ fixturesDir: dir, mode: 'record', gateway, prompts });
    await recorder.run(Extract, { text: 'rec' }, ctx);
    expect(readdirSync(join(dir, 'gw.extract', 'v1'))).toHaveLength(1);

    const replay = createFakeAiGateway({ fixturesDir: dir, prompts });
    expect((await replay.run(Extract, { text: 'rec' }, ctx)).output).toEqual({ city: 'Saint-Jean' });
    expect(replay.calls).toEqual([{ task: 'gw.extract', input: { text: 'rec' }, orgId: ctx.orgId }]);
    const missing = await replay.run(Extract, { text: 'never recorded' }, ctx).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(MissingFixtureError);
    expect(String((missing as Error).message)).toMatch(/AI_FIXTURES=record/);
    const vectors = await replay.embed(['x'], { purpose: 'test', orgId: null });
    expect(vectors.dims).toBe(1536);
  });
});
