import type { AiGateway } from '@bf/ai';
import {
  type BusinessFacets,
  type BusinessFilters,
  type BusinessListItem,
  type BusinessSearchPage,
  type BusinessSearchQuery,
  type Clock,
  DomainError,
  decodeCursor,
  encodeCursor,
  NotFoundError,
  ValidationError,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { GEO_AREA_REPOSITORY, type GeoAreaRepository } from '../../geo/index.ts';
import { AI_GATEWAY } from '../../platform/ai/ai.module.ts';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import {
  hasText,
  type ListingPosition,
  type ListingSort,
  type ListingSpec,
  parseSort,
  sortName,
} from '../domain/listing.ts';
import { type Fused, fuseRankings } from '../domain/rrf.ts';
import { BUSINESS_SEARCH_REPOSITORY, type BusinessSearchRepository } from './listing-ports.ts';

/** Candidates each text ranker contributes before fusion (BF-022). */
export const RANKER_LIMIT = 200;
const DAY_MS = 86_400_000;

const workspaceOf = (auth: AuthContext): string => {
  if (!auth.orgId) throw new Error('Listing route reached without an active workspace');
  return auth.orgId;
};

const invalidCursor = () =>
  new ValidationError('Invalid cursor.', [{ path: ['cursor'], message: 'Invalid cursor' }]);

const TIMESTAMP = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Strict cursor shape for the current sort: a tampered cursor is a 422, never a value Postgres rejects (500). */
async function positionOf(cursor: string, sort: ListingSort): Promise<ListingPosition> {
  const data = await decodeCursor(cursor);
  const [name, value, ...rest] = data.sort;
  if (rest.length > 0 || name !== sortName(sort) || !z.uuid().safeParse(data.id).success)
    throw invalidCursor();
  const valid =
    sort.key === 'recent'
      ? typeof value === 'string' &&
        Number(TIMESTAMP.exec(value)?.[1]) >= 2000 &&
        Number(TIMESTAMP.exec(value)?.[1]) <= 2100
      : sort.key === 'name'
        ? typeof value === 'string' && value.length <= 500
        : value === null || (typeof value === 'number' && Number.isFinite(value));
  if (!valid) throw invalidCursor();
  return { sort: name, value: value as ListingPosition['value'], id: data.id };
}

const nextCursor = (sort: ListingSort, value: string | number | null, id: string) =>
  encodeCursor({ sort: [sortName(sort), value], id });

/**
 * Turns validated filters into a listing specification (area visible to the workspace, distance origin, "added
 * since" instant) and ranks free text (Strategy per ranker, fused with RRF). Shared by the list and facet queries.
 */
@Injectable()
export class ListingResolver {
  constructor(
    @Inject(BUSINESS_SEARCH_REPOSITORY) private readonly repository: BusinessSearchRepository,
    @Inject(GEO_AREA_REPOSITORY) private readonly areas: GeoAreaRepository,
    @Inject(AI_GATEWAY) private readonly ai: AiGateway,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async spec(organizationId: string, filters: BusinessFilters): Promise<ListingSpec> {
    let origin = filters.near ?? null;
    if (filters.area) {
      const area = await this.areas.getById(filters.area, organizationId);
      if (!area) throw new NotFoundError('Area', filters.area);
      origin ??= area.centroid;
    }
    const keywords = filters.keyword ?? [];
    return {
      organizationId,
      filters,
      text: hasText(filters) ? { q: filters.q ?? null, keywords } : null,
      origin,
      addedSince: filters.addedWithinDays
        ? new Date(this.clock.now().getTime() - filters.addedWithinDays * DAY_MS)
        : null,
    };
  }

  /** Text results, best first: full text, name similarity and meaning, fused (empty without text). */
  async rank(spec: ListingSpec): Promise<Fused[]> {
    if (!spec.text) return [];
    const { q, keywords } = spec.text;
    const fullText = q ?? keywords.join(' ');
    const rankings = await Promise.all([
      this.repository.rankFullText(spec, fullText, RANKER_LIMIT),
      q ? this.repository.rankTrigram(spec, q, RANKER_LIMIT) : Promise.resolve([]),
      q ? this.semantic(spec, q) : Promise.resolve([]),
    ]);
    return fuseRankings(rankings);
  }

  /** Meaning-based ranking; skipped (logged) when the embedding model is unavailable (no key, budget). */
  private async semantic(spec: ListingSpec, q: string): Promise<string[]> {
    try {
      const { vectors } = await this.ai.embed([q], { purpose: 'search', orgId: spec.organizationId });
      const vector = vectors[0];
      return vector ? await this.repository.rankVector(spec, vector, RANKER_LIMIT) : [];
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      this.logger.debug({ code: error.code }, 'listing search without semantic ranking');
      return [];
    }
  }
}

@Injectable()
export class SearchBusinessesQuery {
  constructor(
    private readonly resolver: ListingResolver,
    @Inject(BUSINESS_SEARCH_REPOSITORY) private readonly repository: BusinessSearchRepository,
  ) {}

  async execute(auth: AuthContext, query: BusinessSearchQuery): Promise<BusinessSearchPage> {
    const { limit, cursor, sort: requested, ...filters } = query;
    const spec = await this.resolver.spec(workspaceOf(auth), filters);
    const sort = parseSort(requested, spec.text !== null);
    if (sort.key === 'distance' && !spec.origin) {
      throw new ValidationError('Sorting by distance needs `near` or `area`.', [
        { path: ['sort'], message: 'Needs near or area' },
      ]);
    }
    const after = cursor ? await positionOf(cursor, sort) : null;
    if (sort.key === 'relevance') return this.relevancePage(spec, sort, after, limit);
    const rows = await this.repository.page(spec, sort, after, limit + 1);
    const items = rows.slice(0, limit);
    const last = rows.length > limit ? items.at(-1) : undefined;
    return {
      items: items.map((r) => r.item),
      nextCursor: last ? await nextCursor(sort, last.cursorValue, last.item.id) : null,
    };
  }

  private async relevancePage(
    spec: ListingSpec,
    sort: ListingSort,
    after: ListingPosition | null,
    limit: number,
  ): Promise<BusinessSearchPage> {
    if (after !== null && typeof after.value !== 'number') throw invalidCursor();
    const ranked = await this.resolver.rank(spec);
    const remaining = after
      ? ranked.filter(
          (r) => r.score < (after.value as number) || (r.score === after.value && r.id > after.id),
        )
      : ranked;
    const window = remaining.slice(0, limit + 1);
    const byId = new Map(
      (
        await this.repository.byIds(
          spec,
          window.map((r) => r.id),
        )
      ).map((item) => [item.id as string, item]),
    );
    const items = window
      .slice(0, limit)
      .flatMap((r) => (byId.has(r.id) ? [byId.get(r.id) as BusinessListItem] : []));
    const last = window.length > limit ? window[limit - 1] : undefined;
    return {
      items,
      nextCursor: last ? await nextCursor(sort, last.score, last.id) : null,
    };
  }
}

@Injectable()
export class BusinessFacetsQuery {
  constructor(
    private readonly resolver: ListingResolver,
    @Inject(BUSINESS_SEARCH_REPOSITORY) private readonly repository: BusinessSearchRepository,
  ) {}

  /** With text, facets count the ranked results, so they always agree with the list. */
  async execute(auth: AuthContext, filters: BusinessFilters): Promise<BusinessFacets> {
    const spec = await this.resolver.spec(workspaceOf(auth), filters);
    const within = spec.text ? (await this.resolver.rank(spec)).map((r) => r.id) : null;
    return this.repository.facets(spec, within);
  }
}
