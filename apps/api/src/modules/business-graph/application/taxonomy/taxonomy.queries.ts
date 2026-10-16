import {
  type CategoryMapping,
  type CategoryMappingPage,
  type CategoryMappingQuery,
  type CategoryNode,
  type CategorySearchQuery,
  type CategorySearchResult,
  type CategoryTree,
  decodeCursor,
  encodeCursor,
  type Locale,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { normalizeText } from '../../domain/taxonomy/text-match.ts';
import { type MappingRecord, TAXONOMY_REPOSITORY, type TaxonomyRepository } from './ports.ts';
import { TaxonomyCache, type TaxonomySnapshot } from './taxonomy-cache.ts';

/** The active taxonomy as a tree with labels in `locale`. */
@Injectable()
export class GetCategoryTreeQuery {
  constructor(
    private readonly cache: TaxonomyCache,
    @Inject(TAXONOMY_REPOSITORY) private readonly repository: TaxonomyRepository,
  ) {}

  async execute(locale: Locale): Promise<CategoryTree> {
    const [snapshot, version] = await Promise.all([this.cache.get(), this.repository.taxonomyVersion()]);
    const nodes = new Map<string, CategoryNode>();
    const roots: CategoryNode[] = [];
    // Parents come before children in the snapshot.
    for (const category of snapshot.categories) {
      const node: CategoryNode = {
        id: category.id,
        slug: category.slug,
        path: category.path,
        label: category.labels[locale],
        labels: { en: category.labels.en, fr: category.labels.fr },
        icon: category.icon,
        attributes: category.attributes,
        children: [],
      };
      nodes.set(category.id, node);
      const parent = category.parentId ? nodes.get(category.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return { version, items: roots };
  }
}

export function breadcrumbOf(snapshot: TaxonomySnapshot, path: string, locale: Locale): string[] {
  return path
    .split('.')
    .slice(0, -1)
    .map((slug) => snapshot.bySlug.get(slug)?.labels[locale] ?? slug);
}

/**
 * Typeahead: word-prefix matches on labels (then synonyms) in memory, merged with accent-insensitive trigram
 * similarity from the database for typos ("quincaillerie", "coiffeur", "quincailerie").
 */
@Injectable()
export class SearchCategoriesQuery {
  constructor(
    private readonly cache: TaxonomyCache,
    @Inject(TAXONOMY_REPOSITORY) private readonly repository: TaxonomyRepository,
  ) {}

  async execute(query: CategorySearchQuery): Promise<CategorySearchResult> {
    const snapshot = await this.cache.get();
    const q = normalizeText(query.q);
    if (!q) return { items: [] };
    const scores = new Map<string, number>();
    const bump = (slug: string, score: number) => scores.set(slug, Math.max(scores.get(slug) ?? 0, score));
    for (const category of snapshot.categories) {
      const label = normalizeText(category.labels[query.locale]);
      const other = normalizeText(category.labels[query.locale === 'en' ? 'fr' : 'en']);
      const synonyms = [
        ...category.synonyms[query.locale],
        ...category.synonyms[query.locale === 'en' ? 'fr' : 'en'],
      ].map(normalizeText);
      if (label === q) bump(category.slug, 1.2);
      else if (prefixOfWords(label, q)) bump(category.slug, 1.0);
      else if (other === q || synonyms.includes(q)) bump(category.slug, 0.95);
      else if (prefixOfWords(other, q) || synonyms.some((s) => prefixOfWords(s, q)))
        bump(category.slug, 0.85);
    }
    for (const hit of await this.repository.trigramSearch(query.q, query.limit * 2)) {
      bump(hit.slug, hit.score * 0.8);
    }
    const items = [...scores.entries()]
      .map(([slug, score]) => ({ category: snapshot.bySlug.get(slug), score }))
      .filter((x) => x.category !== undefined)
      // Leaves before groups on ties: users search for trades, not sections.
      .sort((a, b) => b.score - a.score || depthOf(b.category?.path) - depthOf(a.category?.path))
      .slice(0, query.limit)
      .map(({ category, score }) => {
        const c = category as NonNullable<typeof category>;
        return {
          id: c.id,
          slug: c.slug,
          path: c.path,
          label: c.labels[query.locale],
          breadcrumb: breadcrumbOf(snapshot, c.path, query.locale),
          score: Math.round(score * 1000) / 1000,
        };
      });
    return { items };
  }
}

const depthOf = (path: string | undefined) => (path ? path.split('.').length : 0);

/** Whether `query` is a prefix of a word sequence in `text` (`"salon de c"` matches `"salon de coiffure"`). */
function prefixOfWords(text: string, query: string): boolean {
  return text === query || text.startsWith(query) || text.includes(` ${query}`);
}

/**
 * `withRationale`: the model's rationale may quote the business it classified (one workspace's data), so only
 * platform operators — who review mappings — see it.
 */
export function toCategoryMapping(
  record: MappingRecord,
  snapshot: TaxonomySnapshot,
  locale: Locale,
  withRationale: boolean,
): CategoryMapping {
  const category = snapshot.byId.get(record.categoryId);
  return {
    id: record.id,
    provider: record.provider,
    providerKey: record.providerKey,
    providerLabel: record.providerLabel,
    categoryId: record.categoryId,
    categorySlug: category?.slug ?? '',
    categoryLabel: category?.labels[locale] ?? '',
    confidence: record.confidence,
    origin: record.origin,
    status: record.status,
    rationale: withRationale ? record.rationale : null,
    createdAt: record.createdAt.toISOString(),
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
  };
}

const CREATED_AT = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Mappings by status (default: LLM proposals awaiting review), newest first. */
@Injectable()
export class ListCategoryMappingsQuery {
  constructor(
    private readonly cache: TaxonomyCache,
    @Inject(TAXONOMY_REPOSITORY) private readonly repository: TaxonomyRepository,
  ) {}

  async execute(auth: AuthContext, query: CategoryMappingQuery): Promise<CategoryMappingPage> {
    const before = query.cursor ? await positionOf(query.cursor) : undefined;
    const [snapshot, rows] = await Promise.all([
      this.cache.get(),
      this.repository.listMappings({
        status: query.status,
        ...(query.provider ? { provider: query.provider } : {}),
        limit: query.limit + 1,
        ...(before ? { before } : {}),
      }),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => toCategoryMapping(row, snapshot, query.locale, auth.operator)),
      nextCursor:
        rows.length > query.limit && last
          ? await encodeCursor({ sort: [last.createdAtText], id: last.id })
          : null,
      canReview: auth.operator,
    };
  }
}

async function positionOf(cursor: string): Promise<{ createdAt: string; id: string }> {
  const data = await decodeCursor(cursor);
  const [at] = data.sort;
  const year = typeof at === 'string' ? Number(CREATED_AT.exec(at)?.[1]) : Number.NaN;
  if (typeof at !== 'string' || !(year >= 2000 && year <= 2100) || !z.uuid().safeParse(data.id).success) {
    throw new ValidationError('Invalid cursor.', [{ path: ['cursor'], message: 'Invalid cursor' }]);
  }
  return { createdAt: at, id: data.id };
}
