import type { AiGateway } from '@bf/ai';
import { BudgetExceededError, fixedClock } from '@bf/contracts';
import { createLogger } from '@bf/observability';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../../platform/config/app-env.ts';
import { CategoryCandidateSearch } from './category-candidates.ts';
import { CategoryClassifier } from './category-classifier.ts';
import type { CategoryRecord, MappingRecord, ScoredSlug, TaxonomyRepository } from './ports.ts';
import { TaxonomyCache } from './taxonomy-cache.ts';

const category = (
  slug: string,
  path: string,
  en: string,
  fr: string,
  synonyms: string[] = [],
): CategoryRecord => ({
  id: `00000000-0000-7000-8000-${String(slug.length).padStart(4, '0')}${slug
    .padEnd(8, '0')
    .slice(0, 8)
    .replace(/[^0-9a-f]/g, 'a')}`,
  slug,
  parentId: null,
  path,
  labels: { en, fr },
  synonyms: { en: synonyms, fr: [] },
  icon: null,
  attributes: {},
  offerRelevance: {},
  sortOrder: 0,
});

const CATEGORIES = [
  category('retail_shopping', 'retail_shopping', 'Shops', 'Commerces'),
  category('hardware_store', 'retail_shopping.hardware_store', 'Hardware store', 'Quincaillerie'),
  category('pharmacy', 'retail_shopping.pharmacy', 'Pharmacy', 'Pharmacie'),
  category('food_drink', 'food_drink', 'Food & drink', 'Restauration'),
  category('restaurant', 'food_drink.restaurant', 'Restaurant', 'Restaurant'),
  category('bar', 'food_drink.bar', 'Bar', 'Bar', ['lounge']),
];
const idOf = (slug: string) => CATEGORIES.find((c) => c.slug === slug)?.id as string;

const mapping = (
  key: string,
  slug: string,
  origin: MappingRecord['origin'],
  confidence = 0.95,
): MappingRecord => ({
  id: `m-${key}`,
  provider: 'google_places',
  providerKey: key,
  providerLabel: null,
  categoryId: idOf(slug),
  confidence,
  origin,
  status: 'active',
  rationale: null,
  createdAt: new Date(0),
  reviewedAt: null,
});

function setup(options: {
  mappings?: MappingRecord[];
  trigram?: ScoredSlug[];
  answer?: (input: { candidates: Array<{ id: string }> }) => unknown;
}) {
  const learned: unknown[] = [];
  const llmCalls: Array<{ candidates: Array<{ id: string }> }> = [];
  const repository = {
    loadActive: async () => ({ categories: CATEGORIES, mappings: options.mappings ?? [] }),
    trigramSearch: async () => options.trigram ?? [],
    hasEmbeddings: async () => false,
    insertLearnedMapping: async (input: unknown) => {
      learned.push(input);
      return true;
    },
  } as unknown as TaxonomyRepository;
  const ai = {
    run: async (_task: unknown, input: { candidates: Array<{ id: string }> }) => {
      llmCalls.push(input);
      if (!options.answer) throw new Error('unexpected LLM call');
      return { output: options.answer(input) };
    },
  } as unknown as AiGateway;
  const logger = createLogger({ service: 'test', level: 'fatal' });
  const cache = new TaxonomyCache(repository, fixedClock('2026-10-15T12:00:00.000Z'));
  const env = { AI_EMBEDDING_MODEL: 'openai:text-embedding-3-small' } as AppEnv;
  const candidates = new CategoryCandidateSearch(repository, ai, env, logger, cache);
  return { classifier: new CategoryClassifier(cache, candidates, repository, ai, logger), learned, llmCalls };
}

describe('CategoryClassifier', () => {
  it('uses an active mapping first, without calling the model', async () => {
    const { classifier, llmCalls } = setup({
      mappings: [mapping('hardware_store', 'hardware_store', 'seed')],
    });
    const result = await classifier.classify({
      providerCategories: [{ provider: 'google_places', key: 'hardware_store' }],
      name: 'Comptoir Martin',
      locale: 'fr',
    });
    expect(result).toMatchObject({
      primary: 'hardware_store',
      primaryId: idOf('hardware_store'),
      origin: 'mapping',
      confidence: 0.95,
      needsReview: false,
    });
    expect(llmCalls).toHaveLength(0);
  });

  it('ranks human mappings over seed mappings', async () => {
    const { classifier } = setup({
      mappings: [mapping('bar', 'bar', 'seed', 0.95), mapping('night_club', 'restaurant', 'human', 0.9)],
    });
    const result = await classifier.classify({
      providerCategories: [
        { provider: 'google_places', key: 'bar' },
        { provider: 'google_places', key: 'night_club' },
      ],
      name: 'Le Comptoir',
      locale: 'fr',
    });
    expect(result).toMatchObject({ primary: 'restaurant', secondary: ['bar'], origin: 'mapping' });
  });

  it('matches labels and synonyms in the name (accent- and case-insensitive)', async () => {
    const { classifier, llmCalls } = setup({});
    const result = await classifier.classify({
      providerCategories: [],
      name: 'QUINCAILLERIE DU PORT',
      locale: 'fr',
    });
    expect(result).toMatchObject({ primary: 'hardware_store', origin: 'synonym', needsReview: false });
    expect(llmCalls).toHaveLength(0);
  });

  it('falls back to the model among retrieved candidates and stores unknown keys for review', async () => {
    const { classifier, learned, llmCalls } = setup({
      trigram: [
        { slug: 'pharmacy', score: 0.4 },
        { slug: 'hardware_store', score: 0.3 },
      ],
      answer: () => ({
        primary: 'pharmacy',
        secondary: ['hardware_store'],
        confidence: 0.97,
        rationale: 'Sells medicine.',
      }),
    });
    const result = await classifier.classify({
      providerCategories: [{ provider: 'google_places', key: 'drugstore_xyz', label: 'Drug store' }],
      name: 'Chez Maryse',
      locale: 'fr',
      orgId: '019a0000-0000-7000-8000-000000000001',
    });
    expect(result).toMatchObject({
      primary: 'pharmacy',
      secondary: ['hardware_store'],
      origin: 'llm',
      confidence: 0.85,
      needsReview: false,
    });
    expect(llmCalls[0]?.candidates.map((c) => c.id)).toEqual(['pharmacy', 'hardware_store']);
    expect(learned).toEqual([
      expect.objectContaining({
        provider: 'google_places',
        providerKey: 'drugstore_xyz',
        providerLabel: 'Drug store',
        categoryId: idOf('pharmacy'),
        confidence: 0.85,
        rationale: 'Sells medicine.',
      }),
    ]);
  });

  it('learns nothing when several specific keys, or only generic keys, are unmapped', async () => {
    const answer = () => ({ primary: 'pharmacy', secondary: [], confidence: 0.9, rationale: 'x' });
    for (const keys of [
      ['key_a', 'key_b'],
      ['point_of_interest', 'establishment'],
    ]) {
      const { classifier, learned } = setup({ trigram: [{ slug: 'pharmacy', score: 0.4 }], answer });
      const result = await classifier.classify({
        providerCategories: keys.map((key) => ({ provider: 'google_places' as const, key })),
        name: 'Chez Maryse',
        locale: 'fr',
      });
      expect(result.primary).toBe('pharmacy');
      expect(learned).toEqual([]);
    }
  });

  it('discards answers outside the candidates', async () => {
    const { classifier, learned } = setup({
      trigram: [{ slug: 'pharmacy', score: 0.4 }],
      answer: () => ({ primary: 'veterinarian', secondary: [], confidence: 1, rationale: 'x' }),
    });
    const result = await classifier.classify({
      providerCategories: [{ provider: 'google_places', key: 'unknown_key' }],
      name: 'Chez Jo',
      locale: 'en',
    });
    expect(result).toMatchObject({ primary: null, origin: 'none', needsReview: true });
    expect(learned).toEqual([]);
  });

  it('keeps the best earlier proposal for review when the model is unavailable', async () => {
    const { classifier } = setup({
      mappings: [mapping('store', 'retail_shopping', 'seed', 0.6)],
      trigram: [{ slug: 'hardware_store', score: 0.3 }],
      answer: () => {
        throw new BudgetExceededError('Monthly AI budget reached.');
      },
    });
    const result = await classifier.classify({
      providerCategories: [{ provider: 'google_places', key: 'store' }],
      name: 'Comptoir Martin',
      locale: 'fr',
    });
    expect(result).toMatchObject({
      primary: 'retail_shopping',
      origin: 'mapping',
      confidence: 0.6,
      needsReview: true,
    });
  });

  it('ignores mappings to inactive categories', async () => {
    const inactive = {
      ...mapping('closed', 'bar', 'seed'),
      categoryId: '019a0000-0000-7000-8000-00000000dead',
    };
    const { classifier } = setup({ mappings: [inactive] });
    const result = await classifier.classify({
      providerCategories: [{ provider: 'google_places', key: 'closed' }],
      name: 'Atelier 5',
      locale: 'en',
    });
    expect(result.primary).toBeNull();
  });
});
