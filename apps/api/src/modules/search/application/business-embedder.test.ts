import { type AiGateway, AiProviderNotConfiguredError, AiProviderUnavailableError } from '@bf/ai';
import { fakeEmbedding } from '@bf/ai/testing';
import { BudgetExceededError } from '@bf/contracts';
import { createLogger } from '@bf/observability';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../platform/config/app-env.ts';
import { composeEmbeddingText } from '../domain/embedding-text.ts';
import { BusinessEmbedder, embeddingTextHash } from './business-embedder.ts';
import type { BusinessEmbeddingRepository, EmbeddingSourceRow } from './embedding-ports.ts';

const MODEL = 'openai:text-embedding-3-small';
const row = (n: number, overrides: Partial<EmbeddingSourceRow> = {}): EmbeddingSourceRow => ({
  id: `0192a1b2-0000-7000-8000-00000000000${n}`,
  displayName: `Business ${n}`,
  categories: [],
  locality: null,
  countryCode: null,
  shortDescription: null,
  priceLevel: null,
  embeddingModel: null,
  embeddingTextHash: null,
  ...overrides,
});
const current = (n: number) => {
  const r = row(n);
  return { ...r, embeddingModel: MODEL, embeddingTextHash: embeddingTextHash(composeEmbeddingText(r)) };
};

function setup(rows: EmbeddingSourceRow[], embed?: AiGateway['embed']) {
  const saved: Array<{ id: string; model: string }> = [];
  const repository: BusinessEmbeddingRepository = {
    sources: async (ids) => rows.filter((r) => ids.includes(r.id)),
    sourcesAfter: async (after, limit) => rows.filter((r) => after === null || r.id > after).slice(0, limit),
    save: async (id, _vector, model) => {
      saved.push({ id, model });
    },
  };
  const gateway = {
    embed: vi.fn(
      embed ??
        (async (texts: readonly string[]) => ({
          vectors: texts.map((t) => fakeEmbedding(t)),
          model: 'm',
          dims: 1536,
        })),
    ),
  } as unknown as AiGateway & { embed: ReturnType<typeof vi.fn> };
  const embedder = new BusinessEmbedder(
    repository,
    gateway,
    { AI_EMBEDDING_MODEL: MODEL } as AppEnv,
    createLogger({ service: 'test', level: 'fatal' }),
  );
  return { embedder, saved, gateway };
}

describe('BusinessEmbedder', () => {
  it('embeds only businesses whose text or model changed', async () => {
    const { embedder, saved, gateway } = setup([
      row(1),
      current(2),
      { ...current(3), embeddingModel: 'old:model' },
    ]);
    const report = await embedder.embed([row(1).id, row(2).id, row(3).id]);
    expect(report).toEqual({ embedded: 2, upToDate: 1 });
    expect(saved.map((s) => s.id)).toEqual([row(1).id, row(3).id]);
    expect(saved.every((s) => s.model === MODEL)).toBe(true);
    expect(gateway.embed).toHaveBeenCalledWith(expect.any(Array), { purpose: 'business', orgId: null });
    expect(await embedder.embed([row(2).id])).toEqual({ embedded: 0, upToDate: 1 });
  });

  it.each([
    ['no provider key', new AiProviderNotConfiguredError('openai', 'openai_api_key')],
    ['no budget', new BudgetExceededError('AI budget reached')],
  ])('skips (does not retry) without %s', async (_label, error) => {
    const { embedder, saved } = setup([row(1)], async () => {
      throw error;
    });
    expect(await embedder.embed([row(1).id])).toEqual({ embedded: 0, upToDate: 0, skipped: error.code });
    expect(saved).toEqual([]);
  });

  it('lets provider outages throw so the job retries', async () => {
    const { embedder } = setup([row(1)], async () => {
      throw new AiProviderUnavailableError('openai', 'down');
    });
    await expect(embedder.embed([row(1).id])).rejects.toBeInstanceOf(AiProviderUnavailableError);
  });

  it('reindexes everything in batches and stops at a skip', async () => {
    const { embedder, saved, gateway } = setup([row(1), current(2), row(3), row(4)]);
    const progress: number[] = [];
    expect(await embedder.reindex({ batchSize: 2, onBatch: (r) => progress.push(r.embedded) })).toEqual({
      embedded: 3,
      upToDate: 1,
    });
    expect(progress).toEqual([1, 3]);
    expect(saved).toHaveLength(3);
    expect(gateway.embed).toHaveBeenCalledTimes(2);
    const stopped = setup([row(1), row(2), row(3)], async () => {
      throw new BudgetExceededError('AI budget reached');
    });
    expect(await stopped.embedder.reindex({ batchSize: 1 })).toEqual({
      embedded: 0,
      upToDate: 0,
      skipped: 'BUDGET_EXCEEDED',
    });
    expect(stopped.gateway.embed).toHaveBeenCalledTimes(1);
  });
});
