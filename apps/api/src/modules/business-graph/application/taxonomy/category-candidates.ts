import type { AiGateway } from '@bf/ai';
import { DomainError } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { AI_GATEWAY } from '../../../platform/ai/ai.module.ts';
import { APP_ENV, type AppEnv } from '../../../platform/config/app-env.ts';
import { LOGGER } from '../../../platform/logging/logger.ts';
import { type ScoredSlug, TAXONOMY_REPOSITORY, type TaxonomyRepository } from './ports.ts';
import { TaxonomyCache } from './taxonomy-cache.ts';

export interface CategoryCandidate {
  readonly id: string;
  readonly slug: string;
  readonly path: string;
  readonly labels: { readonly en: string; readonly fr: string };
  /** Reciprocal-rank-fusion score; comparable within one call only. */
  readonly score: number;
}

const RRF_K = 60;

/** Reciprocal Rank Fusion of several rankings (each best first). */
export function fuseRankings(rankings: ReadonlyArray<readonly ScoredSlug[]>): ScoredSlug[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((hit, rank) => {
      scores.set(hit.slug, (scores.get(hit.slug) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([slug, score]) => ({ slug, score }))
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
}

/**
 * Candidate categories for free text (BF-015; used by the classifier's LLM step and intent parsing, BF-021):
 * accent-insensitive trigram matches fused with embedding similarity when categories are embedded. Without an
 * embedding (no key, budget, not yet embedded) it degrades to trigram only.
 */
@Injectable()
export class CategoryCandidateSearch {
  constructor(
    @Inject(TAXONOMY_REPOSITORY) private readonly repository: TaxonomyRepository,
    @Inject(AI_GATEWAY) private readonly ai: AiGateway,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly cache: TaxonomyCache,
  ) {}

  /**
   * `texts`: short pieces (a name, provider labels, a prompt…). Trigram similarity is measured per piece — on a long
   * concatenation it would match almost nothing — while the embedding sees them together.
   */
  async find(
    texts: string | readonly string[],
    k: number,
    options: { readonly orgId: string | null },
  ): Promise<CategoryCandidate[]> {
    const pieces = (typeof texts === 'string' ? [texts] : texts)
      .map((t) => t.trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 8);
    if (pieces.length === 0) return [];
    const [trigrams, vector] = await Promise.all([
      Promise.all(pieces.map((piece) => this.repository.trigramSearch(piece, k * 2))),
      this.vectorRanking(pieces.join(' ').slice(0, 500), k * 2, options.orgId),
    ]);
    const snapshot = await this.cache.get();
    return fuseRankings(vector ? [...trigrams, vector] : trigrams)
      .map((hit) => ({ hit, category: snapshot.bySlug.get(hit.slug) }))
      .filter((x) => x.category !== undefined)
      .slice(0, k)
      .map(({ hit, category }) => ({
        id: category?.id as string,
        slug: hit.slug,
        path: category?.path as string,
        labels: category?.labels as CategoryCandidate['labels'],
        score: hit.score,
      }));
  }

  private async vectorRanking(
    text: string,
    limit: number,
    orgId: string | null,
  ): Promise<ScoredSlug[] | null> {
    const model = this.env.AI_EMBEDDING_MODEL;
    if (!(await this.repository.hasEmbeddings(model))) return null;
    try {
      const { vectors } = await this.ai.embed([text], { purpose: 'category.search', orgId });
      const [vector] = vectors;
      return vector ? await this.repository.vectorSearch(vector, model, limit) : null;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      this.logger.warn({ code: error.code }, 'category candidate search without embeddings');
      return null;
    }
  }
}
