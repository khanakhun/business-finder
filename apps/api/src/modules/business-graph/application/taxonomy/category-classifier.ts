import { type AiGateway, NO_CATEGORY, TaxonomyClassifyBusiness } from '@bf/ai';
import { DomainError, type Locale, type TaxonomyProvider } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { AI_GATEWAY } from '../../../platform/ai/ai.module.ts';
import { LOGGER } from '../../../platform/logging/logger.ts';
import {
  accepts,
  type ClassificationResult,
  decide,
  proposeFromMappings,
  type StepProposal,
} from '../../domain/taxonomy/classification.ts';
import { matchSynonyms } from '../../domain/taxonomy/text-match.ts';
import { CategoryCandidateSearch } from './category-candidates.ts';
import { TAXONOMY_REPOSITORY, type TaxonomyRepository } from './ports.ts';
import { mappingKey, TaxonomyCache, type TaxonomySnapshot } from './taxonomy-cache.ts';

export interface ProviderCategory {
  readonly provider: TaxonomyProvider;
  readonly key: string;
  readonly label?: string;
}

export interface ClassifyInput {
  readonly providerCategories: readonly ProviderCategory[];
  readonly name: string;
  readonly websiteSnippet?: string;
  readonly locale: Locale;
  /** Workspace paying for the LLM fallback (null for platform ingestion). */
  readonly orgId?: string | null;
}

export interface CategoryClassification extends ClassificationResult {
  /** Ids of `primary` / `secondary` (the result only ever names active categories). */
  readonly primaryId: string | null;
  readonly secondaryIds: readonly string[];
}

const LLM_CANDIDATES = 12;
/** What the task accepts (and so all the model sees). */
const MAX_PROVIDER_CATEGORIES = 20;
/** Provider keys too broad to map to one category. */
const GENERIC_PROVIDER_KEYS = new Set([
  'point_of_interest',
  'establishment',
  'store',
  'service',
  'food',
  'health',
  'finance',
  'premise',
  'local_business',
  'shopping',
  'shopping_and_retail',
  'business_and_professional_services',
]);
/** The model's confidence is capped: an LLM pick alone never beats a curated mapping. */
const LLM_MAX_CONFIDENCE = 0.85;

/**
 * Classifies a business into the taxonomy (BF-015): active provider mappings → label/synonym matches on the name
 * and provider labels → LLM choice among retrieved candidates. Never returns an unknown or inactive category.
 * Provider keys the LLM step resolves are stored as `llm` mappings awaiting review.
 */
@Injectable()
export class CategoryClassifier {
  constructor(
    private readonly cache: TaxonomyCache,
    private readonly candidates: CategoryCandidateSearch,
    @Inject(TAXONOMY_REPOSITORY) private readonly repository: TaxonomyRepository,
    @Inject(AI_GATEWAY) private readonly ai: AiGateway,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async classify(input: ClassifyInput): Promise<CategoryClassification> {
    const snapshot = await this.cache.get();
    const proposals: Array<StepProposal | null> = [];

    const mapped = this.mappingStep(snapshot, input);
    proposals.push(mapped);
    if (accepts(mapped)) return this.withIds(snapshot, decide(proposals));

    const synonym = this.synonymStep(snapshot, input);
    proposals.push(synonym);
    if (accepts(synonym)) return this.withIds(snapshot, decide(proposals));

    proposals.push(await this.llmStep(snapshot, input, proposals));
    return this.withIds(snapshot, decide(proposals));
  }

  private mappingStep(snapshot: TaxonomySnapshot, input: ClassifyInput): StepProposal | null {
    const found = input.providerCategories.flatMap((pc) => {
      const mapping = snapshot.mappings.get(mappingKey(pc.provider, pc.key));
      const category = mapping ? snapshot.byId.get(mapping.categoryId) : undefined;
      return mapping && category
        ? [{ slug: category.slug, origin: mapping.origin, confidence: mapping.confidence }]
        : [];
    });
    return proposeFromMappings(found);
  }

  private synonymStep(snapshot: TaxonomySnapshot, input: ClassifyInput): StepProposal | null {
    const texts = [
      input.name,
      ...input.providerCategories.flatMap((pc) => [pc.label ?? '', pc.key.replace(/[_=:./-]+/g, ' ')]),
    ].filter(Boolean);
    const [best, ...rest] = matchSynonyms(snapshot.synonyms, texts).filter((m) =>
      snapshot.bySlug.has(m.slug),
    );
    if (!best) return null;
    return {
      origin: 'synonym',
      primary: best.slug,
      secondary: rest
        .filter((m) => m.score >= 0.7)
        .map((m) => m.slug)
        .slice(0, 3),
      confidence: best.score,
    };
  }

  private async llmStep(
    snapshot: TaxonomySnapshot,
    input: ClassifyInput,
    earlier: ReadonlyArray<StepProposal | null>,
  ): Promise<StepProposal | null> {
    const sent = input.providerCategories.slice(0, MAX_PROVIDER_CATEGORIES);
    const pieces = [
      input.name,
      ...sent.map((pc) => pc.label ?? pc.key.replace(/[_=:./-]+/g, ' ')),
      input.websiteSnippet ?? '',
    ];
    try {
      const retrieved = await this.candidates.find(pieces, LLM_CANDIDATES, { orgId: input.orgId ?? null });
      // Earlier steps' picks stay in the running even when retrieval missed them.
      const slugs = [
        ...new Set([
          ...earlier.flatMap((p) => (p ? [p.primary, ...p.secondary] : [])),
          ...retrieved.map((c) => c.slug),
        ]),
      ].filter((slug) => snapshot.bySlug.has(slug));
      if (slugs.length === 0) return null;
      const candidates = slugs.slice(0, LLM_CANDIDATES + 4).map((slug) => {
        const category = snapshot.bySlug.get(slug);
        return {
          id: slug,
          label: category?.labels[input.locale] ?? slug,
          path: (category?.path ?? slug).replace(/\./g, ' › '),
        };
      });
      const { output } = await this.ai.run(
        TaxonomyClassifyBusiness,
        {
          name: input.name,
          providerCategories: sent.map((pc) => ({
            provider: pc.provider,
            key: pc.key,
            ...(pc.label ? { label: pc.label } : {}),
          })),
          ...(input.websiteSnippet ? { websiteSnippet: input.websiteSnippet.slice(0, 2_000) } : {}),
          locale: input.locale,
          candidates,
        },
        { orgId: input.orgId ?? null },
      );
      const allowed = new Set(candidates.map((c) => c.id));
      if (output.primary === NO_CATEGORY || !allowed.has(output.primary)) {
        if (output.primary !== NO_CATEGORY) {
          this.logger.warn(
            { answer: output.primary.slice(0, 60) },
            'classifier LLM answered outside its candidates',
          );
        }
        return null;
      }
      const proposal: StepProposal = {
        origin: 'llm',
        primary: output.primary,
        secondary: output.secondary.filter((s) => allowed.has(s) && s !== output.primary).slice(0, 3),
        confidence: Math.min(output.confidence, LLM_MAX_CONFIDENCE),
      };
      await this.learnMappings(snapshot, sent, proposal, output.rationale);
      return proposal;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      this.logger.warn({ code: error.code }, 'classifier LLM step unavailable');
      return null;
    }
  }

  /**
   * The provider key the model resolved becomes an `llm` mapping awaiting review — only when exactly one specific,
   * well-formed key it saw is unmapped: with several, which one the pick explains is unknown, and generic keys
   * describe nothing. Inert until a platform operator approves it.
   */
  private async learnMappings(
    snapshot: TaxonomySnapshot,
    sent: readonly ProviderCategory[],
    proposal: StepProposal,
    rationale: string,
  ): Promise<void> {
    const category = snapshot.bySlug.get(proposal.primary);
    if (!category) return;
    const unmapped = sent.filter(
      (pc) =>
        !snapshot.mappings.has(mappingKey(pc.provider, pc.key)) &&
        !GENERIC_PROVIDER_KEYS.has(pc.key) &&
        pc.key.length <= 200 &&
        (pc.label ?? '').length <= 200,
    );
    const [only] = unmapped;
    if (!only || unmapped.length !== 1) return;
    await this.repository.insertLearnedMapping({
      provider: only.provider,
      providerKey: only.key,
      providerLabel: only.label ?? null,
      categoryId: category.id,
      confidence: proposal.confidence,
      rationale: rationale.slice(0, 400),
    });
  }

  private withIds(snapshot: TaxonomySnapshot, result: ClassificationResult): CategoryClassification {
    const idOf = (slug: string) => snapshot.bySlug.get(slug)?.id;
    const secondary = result.secondary.filter((slug) => idOf(slug) !== undefined);
    return {
      ...result,
      secondary,
      primaryId: result.primary ? (idOf(result.primary) ?? null) : null,
      secondaryIds: secondary.map((slug) => idOf(slug) as string),
    };
  }
}
