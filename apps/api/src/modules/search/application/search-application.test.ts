import type { AiGateway } from '@bf/ai';
import {
  BudgetExceededError,
  BusinessExportQuerySchema,
  type BusinessFacets,
  type BusinessFiltersInput,
  type BusinessListItem,
  BusinessSearchQuerySchema,
  ConflictError,
  encodeCursor,
  ForbiddenError,
  fixedClock,
  NotFoundError,
  type Permission,
  ValidationError,
} from '@bf/contracts';
import { createLogger } from '@bf/observability';
import { describe, expect, it, vi } from 'vitest';
import type { GeoAreaRecord, GeoAreaRepository } from '../../geo/index.ts';
import type { AppEnv } from '../../platform/config/app-env.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import type { AuditLogger } from '../../workspace/index.ts';
import type { ListingPosition, ListingSort, ListingSpec } from '../domain/listing.ts';
import type {
  ListRecord,
  ListRepository,
  SavedSearchRecord,
  SavedSearchRepository,
} from './collection-ports.ts';
import { BusinessLists, SavedSearches } from './collections.ts';
import { csvCell, ExportBusinesses } from './export-businesses.ts';
import { BusinessFacetsQuery, ListingResolver, SearchBusinessesQuery } from './listing.queries.ts';
import type { BusinessSearchRepository, ExportExtras, ListingRow, RankingCache } from './listing-ports.ts';

// The search use cases over in-memory fakes (SQL and HTTP are covered by the integration suite).

const ORG = '0192a1b2-0000-7000-8000-0000000000aa';
const USER = '0192a1b2-0000-7000-8000-0000000000bb';
const AREA = '0192a1b2-0000-7000-8000-0000000000cc';
const id = (n: number) => `0192a1b2-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-10-14T12:00:00Z');

const auth = (
  permissions: Permission[] = ['business:read', 'business:write', 'outreach:send'],
): AuthContext => ({ orgId: ORG, userId: USER, permissions: new Set(permissions) }) as unknown as AuthContext;

const item = (n: number, overrides: Partial<BusinessListItem> = {}): BusinessListItem =>
  ({
    id: id(n),
    displayName: `Business ${n}`,
    primaryCategoryId: null,
    operatingStatus: 'operational',
    websiteUrl: null,
    primaryPhone: `+59059000000${n}`,
    locality: 'Gustavia',
    countryCode: 'BL',
    location: { lat: 17.9, lng: -62.85 },
    ratingAvg: 4,
    ratingCount: n,
    pipelineStatus: 'new',
    score: n,
    tier: null,
    tags: ['vip'],
    ownerUserId: null,
    trackedAt: NOW.toISOString(),
    lastActivityAt: null,
    distanceMeters: null,
    ...overrides,
  }) as BusinessListItem;

/** Items 1…n; `page` orders them by score desc (the only sort these tests page). */
function fakeRepository(
  n: number,
  ranked: { fullText?: string[]; trigram?: string[]; vector?: string[] } = {},
) {
  const items = Array.from({ length: n }, (_, i) => item(i + 1));
  const calls = { vector: 0, page: [] as Array<ListingPosition | null> };
  const repository: BusinessSearchRepository = {
    page: async (_spec: ListingSpec, _sort: ListingSort, after: ListingPosition | null, limit: number) => {
      calls.page.push(after);
      const sorted = [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const start = after ? sorted.findIndex((i) => i.id === after.id) + 1 : 0;
      return sorted.slice(start, start + limit).map((i): ListingRow => ({ item: i, cursorValue: i.score }));
    },
    byIds: async (_spec, ids) => items.filter((i) => ids.includes(i.id)),
    rankFullText: async () => ranked.fullText ?? [],
    rankTrigram: async () => ranked.trigram ?? [],
    rankVector: async () => {
      calls.vector++;
      return ranked.vector ?? [];
    },
    count: async (spec) => (spec.addedSince && spec.addedSince > NOW ? 0 : items.length),
    exportExtras: async (ids) =>
      new Map(
        ids.map((i): [string, ExportExtras] => [
          i,
          { category: 'Spa', address: '1 Rue, Gustavia', postalCode: '97133', email: 'hello@spa.example' },
        ]),
      ),
    facets: async (_spec, within) => ({ total: within?.length ?? items.length }) as BusinessFacets,
  };
  return { repository, items, calls };
}

function resolver(
  repository: BusinessSearchRepository,
  options: { embed?: AiGateway['embed']; area?: Partial<GeoAreaRecord> | null } = {},
) {
  const areas = {
    getById: async (areaId: string) =>
      options.area === null || areaId !== AREA
        ? undefined
        : ({ id: AREA, centroid: { lat: 17.89, lng: -62.84 }, ...options.area } as GeoAreaRecord),
  } as unknown as GeoAreaRepository;
  const ai = {
    embed:
      options.embed ??
      (async () => ({ vectors: [Array.from({ length: 1536 }, () => 0.01)], model: 'm', dims: 1536 })),
  } as unknown as AiGateway;
  const store = new Map<string, Array<{ id: string; score: number }>>();
  const cache: RankingCache = {
    get: async (key) => store.get(key),
    set: async (key, value) => {
      store.set(key, [...value]);
    },
  };
  return new ListingResolver(
    repository,
    areas,
    ai,
    fixedClock(NOW),
    createLogger({ service: 'test', level: 'fatal' }),
    cache,
  );
}

const query = (input: Record<string, unknown>) => BusinessSearchQuerySchema.parse(input);

describe('SearchBusinessesQuery', () => {
  it('pages a sort with cursors that remember the sort', async () => {
    const { repository } = fakeRepository(5);
    const search = new SearchBusinessesQuery(resolver(repository), repository);
    const first = await search.execute(auth(), query({ sort: '-score', limit: '2' }));
    expect(first.items.map((i) => i.score)).toEqual([5, 4]);
    const second = await search.execute(
      auth(),
      query({ sort: '-score', limit: '2', cursor: first.nextCursor }),
    );
    expect(second.items.map((i) => i.score)).toEqual([3, 2]);
    const last = await search.execute(
      auth(),
      query({ sort: '-score', limit: '2', cursor: second.nextCursor }),
    );
    expect(last).toMatchObject({ nextCursor: null });
    // A cursor from another sort, or with a value of the wrong type, is a 422.
    await expect(
      search.execute(auth(), query({ sort: 'rating', cursor: first.nextCursor })),
    ).rejects.toBeInstanceOf(ValidationError);
    const forged = await encodeCursor({ sort: ['-recent', 42], id: id(1) });
    await expect(search.execute(auth(), query({ cursor: forged }))).rejects.toBeInstanceOf(ValidationError);
    const badName = await encodeCursor({ sort: ['name', 7], id: id(1) });
    await expect(search.execute(auth(), query({ sort: 'name', cursor: badName }))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('fuses the text rankers (RRF) and pages the fused order', async () => {
    const { repository } = fakeRepository(4, {
      fullText: [id(1), id(2)],
      trigram: [id(2)],
      vector: [id(3), id(2)],
    });
    const search = new SearchBusinessesQuery(resolver(repository), repository);
    const all = await search.execute(auth(), query({ q: 'spa' }));
    expect(all.items.map((i) => i.id)).toEqual([id(2), id(1), id(3)]);
    const first = await search.execute(auth(), query({ q: 'spa', limit: '1' }));
    const rest = await search.execute(auth(), query({ q: 'spa', limit: '5', cursor: first.nextCursor }));
    expect([...first.items, ...rest.items].map((i) => i.id)).toEqual([id(2), id(1), id(3)]);
    expect(rest.nextCursor).toBeNull();
    // Keywords alone rank by full text only.
    const keywords = await search.execute(auth(), query({ keyword: 'vegan' }));
    expect(keywords.items.map((i) => i.id)).toEqual([id(1), id(2)]);
  });

  it('pages one cached ranking even if embeddings fail between pages', async () => {
    const { repository } = fakeRepository(3, { fullText: [id(1)], vector: [id(2), id(3)] });
    let fail = false;
    const listing = resolver(repository, {
      embed: async () => {
        if (fail) throw new BudgetExceededError('AI budget reached');
        return { vectors: [Array.from({ length: 1536 }, () => 0.01)], model: 'm', dims: 1536 };
      },
    });
    const search = new SearchBusinessesQuery(listing, repository);
    const first = await search.execute(auth(), query({ q: 'spa', limit: '1' }));
    fail = true;
    const rest = await search.execute(auth(), query({ q: 'spa', limit: '5', cursor: first.nextCursor }));
    expect([...first.items, ...rest.items].map((i) => i.id).sort()).toEqual([id(1), id(2), id(3)]);
  });

  it('ranks without meaning when embeddings are unavailable, and rethrows other failures', async () => {
    const { repository, calls } = fakeRepository(2, { fullText: [id(1)] });
    const noBudget = resolver(repository, {
      embed: async () => {
        throw new BudgetExceededError('AI budget reached');
      },
    });
    expect(
      (await new SearchBusinessesQuery(noBudget, repository).execute(auth(), query({ q: 'spa' }))).items,
    ).toHaveLength(1);
    expect(calls.vector).toBe(0);
    const broken = resolver(repository, {
      embed: async () => {
        throw new Error('bug');
      },
    });
    await expect(
      new SearchBusinessesQuery(broken, repository).execute(auth(), query({ q: 'spa' })),
    ).rejects.toThrow('bug');
  });

  it('resolves areas visible to the workspace and needs an origin to sort by distance', async () => {
    const { repository } = fakeRepository(1);
    const search = new SearchBusinessesQuery(resolver(repository), repository);
    await expect(search.execute(auth(), query({ sort: 'distance' }))).rejects.toBeInstanceOf(ValidationError);
    expect((await search.execute(auth(), query({ sort: 'distance', area: AREA }))).items).toHaveLength(1);
    await expect(search.execute(auth(), query({ area: id(99) }))).rejects.toBeInstanceOf(NotFoundError);
    const spec = await resolver(repository).spec(ORG, query({ addedWithinDays: '2', near: '1,2' }));
    expect(spec).toMatchObject({
      origin: { lat: 1, lng: 2 },
      addedSince: new Date('2026-10-12T12:00:00Z'),
      text: null,
    });
  });

  it("ranks facets without the facet dimensions' own filters", async () => {
    const { repository } = fakeRepository(3, { fullText: [id(1)] });
    const seen: unknown[] = [];
    const spy = {
      ...repository,
      rankFullText: async (spec: ListingSpec, q: string, limit: number) => {
        seen.push(spec.filters);
        return repository.rankFullText(spec, q, limit);
      },
    };
    await new BusinessFacetsQuery(resolver(spy), spy).execute(
      auth(),
      query({
        q: 'spa',
        status: 'new',
        tier: 'A',
        website: 'none',
        hasEmail: 'true',
        'rating[gte]': '4',
        tag: 'vip',
      }),
    );
    expect(seen[0]).toMatchObject({ website: 'any', tag: ['vip'] });
    expect(seen[0]).not.toHaveProperty('status');
    expect(seen[0]).not.toHaveProperty('tier');
    expect(seen[0]).not.toHaveProperty('hasEmail');
  });

  it('counts facets over the ranked results when there is text', async () => {
    const { repository } = fakeRepository(3, { fullText: [id(1), id(3)] });
    const facets = new BusinessFacetsQuery(resolver(repository), repository);
    expect((await facets.execute(auth(), query({ q: 'spa' }))).total).toBe(2);
    expect((await facets.execute(auth(), query({}))).total).toBe(3);
  });
});

function fakeSavedSearches() {
  const rows = new Map<string, SavedSearchRecord>();
  const repository: SavedSearchRepository = {
    count: async () => rows.size,
    list: async (_org, viewer, page) =>
      [...rows.values()]
        .filter((r) => r.visibility === 'workspace' || r.createdBy === viewer)
        .slice(0, page.limit),
    find: async (_org, viewer, searchId) => {
      const row = rows.get(searchId);
      return row && (row.visibility === 'workspace' || row.createdBy === viewer) ? row : undefined;
    },
    insert: async (record) => {
      rows.set(record.id, {
        ...record,
        lastRunAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        position: { createdAt: '2026-10-14T12:00:00.000000Z', id: record.id },
      });
    },
    update: async (_org, searchId, patch) => {
      const row = rows.get(searchId) as SavedSearchRecord;
      rows.set(searchId, {
        ...row,
        ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      });
    },
    markRun: async (_org, searchId, at) => {
      rows.set(searchId, { ...(rows.get(searchId) as SavedSearchRecord), lastRunAt: at });
    },
    delete: async (_org, searchId) => {
      rows.delete(searchId);
    },
  };
  return { repository, rows };
}

describe('SavedSearches', () => {
  it('creates, counts new matches until run, and lets only the creator change it', async () => {
    const { repository: listing } = fakeRepository(3);
    const { repository, rows } = fakeSavedSearches();
    const clock = { now: () => new Date('2026-10-15T00:00:00Z') };
    const searches = new SavedSearches(repository, resolver(listing), clock);
    const created = await searches.create(auth(), {
      name: 'Spas',
      filters: { q: undefined as never, status: ['new'] } as unknown as Record<string, string[]>,
      visibility: 'workspace',
      notifyNew: false,
    });
    expect(created).toMatchObject({ name: 'Spas', newMatches: 3, mine: true, lastRunAt: null, sort: null });
    expect((await searches.run(auth(), created.id)).newMatches).toBe(3);
    expect((await searches.get(auth(), created.id)).newMatches).toBe(0);
    expect((await searches.list(auth(), { limit: 10 })).items).toHaveLength(1);
    const stranger = { ...auth(), userId: id(77) } as AuthContext;
    expect((await searches.get(stranger, created.id)).mine).toBe(false);
    await expect(searches.update(stranger, created.id, { name: 'Mine' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(searches.delete(stranger, created.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await searches.update(auth(), created.id, { name: 'Renamed' })).name).toBe('Renamed');
    await searches.delete(auth(), created.id);
    await expect(searches.get(auth(), created.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(rows.size).toBe(0);
  });

  it('counts nothing for a search whose area is gone', async () => {
    const { repository: listing } = fakeRepository(3);
    const { repository } = fakeSavedSearches();
    const searches = new SavedSearches(repository, resolver(listing, { area: null }), fixedClock(NOW));
    const created = await searches.create(auth(), {
      name: 'Gone',
      filters: { area: AREA },
      visibility: 'private',
      notifyNew: true,
    });
    expect(created.newMatches).toBe(0);
  });
});

describe('BusinessLists', () => {
  function fakeLists() {
    const lists = new Map<string, ListRecord>();
    const items = new Map<string, Set<string>>();
    const tracked = new Set([id(1), id(2)]);
    const record = (listId: string): ListRecord => ({
      ...(lists.get(listId) as ListRecord),
      itemCount: items.get(listId)?.size ?? 0,
    });
    const repository: ListRepository = {
      list: async () => [...lists.keys()].map(record),
      find: async (_org, listId) => (lists.has(listId) ? record(listId) : undefined),
      insert: async (r) => {
        if ([...lists.values()].some((l) => l.name === r.name)) return false;
        lists.set(r.id, {
          ...r,
          itemCount: 0,
          createdAt: NOW,
          updatedAt: NOW,
          position: { createdAt: '2026-10-14T12:00:00.000000Z', id: r.id },
        });
        return true;
      },
      update: async (_org, listId, patch) => {
        if (patch.name && [...lists.values()].some((l) => l.name === patch.name && l.id !== listId))
          return false;
        lists.set(listId, {
          ...(lists.get(listId) as ListRecord),
          ...(patch.name ? { name: patch.name } : {}),
        });
        return true;
      },
      delete: async (_org, listId) => {
        lists.delete(listId);
      },
      addItems: async (_org, listId, ids) => {
        const set = items.get(listId) ?? new Set();
        items.set(listId, set);
        let added = 0;
        for (const b of ids) {
          if (tracked.has(b) && !set.has(b)) {
            set.add(b);
            added++;
          }
        }
        return { added, notTracked: ids.filter((b) => !tracked.has(b)) };
      },
      removeItems: async (listId, ids) => ids.filter((b) => items.get(listId)?.delete(b)).length,
    };
    return new BusinessLists(repository);
  }

  it('creates unique lists and adds/removes tracked businesses idempotently', async () => {
    const service = fakeLists();
    const list = await service.create(auth(), { name: 'Hot' });
    await expect(service.create(auth(), { name: 'Hot' })).rejects.toBeInstanceOf(ConflictError);
    expect(await service.addItems(auth(), list.id, [id(1), id(1), id(3)])).toEqual({
      changed: 1,
      unchanged: 0,
      notTracked: [id(3)],
      itemCount: 1,
    });
    expect(await service.addItems(auth(), list.id, [id(1), id(2)])).toMatchObject({
      changed: 1,
      unchanged: 1,
      itemCount: 2,
    });
    expect(await service.removeItems(auth(), list.id, [id(2), id(9)])).toMatchObject({
      changed: 1,
      unchanged: 1,
      itemCount: 1,
    });
    const other = await service.create(auth(), { name: 'Cold', description: 'later' });
    await expect(service.update(auth(), other.id, { name: 'Hot' })).rejects.toBeInstanceOf(ConflictError);
    expect((await service.update(auth(), other.id, { name: 'Warm' })).name).toBe('Warm');
    expect((await service.list(auth(), { limit: 1 })).nextCursor).not.toBeNull();
    await service.delete(auth(), other.id);
    await expect(service.get(auth(), other.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.addItems(auth(), id(99), [id(1)])).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('ExportBusinesses', () => {
  const exporter = (n: number, ranked: string[] = [], max = 50_000) => {
    const { repository, calls } = fakeRepository(n, { fullText: ranked });
    const audit = { record: vi.fn(async () => undefined) };
    const service = new ExportBusinesses(
      resolver(repository),
      repository,
      audit as unknown as AuditLogger,
      { SEARCH_EXPORT_MAX_ROWS: max } as AppEnv,
    );
    return { service, audit, calls };
  };
  const collect = async (gen: AsyncGenerator<string>) => {
    let text = '';
    for await (const chunk of gen) text += chunk;
    return text.trim().split('\r\n');
  };
  const exportQuery = (input: BusinessFiltersInput & Record<string, unknown>) =>
    BusinessExportQuerySchema.parse(input);

  it('chooses columns by permission', () => {
    const { service } = exporter(1);
    expect(service.fieldsFor(auth(), exportQuery({}))).toContain('email');
    expect(service.fieldsFor(auth(['business:read']), exportQuery({}))).not.toContain('email');
    expect(service.fieldsFor(auth(['business:read']), exportQuery({}))).toContain('phone');
    expect(service.fieldsFor(auth(['business:read']), exportQuery({ fields: 'name,name,score' }))).toEqual([
      'name',
      'score',
    ]);
    expect(() => service.fieldsFor(auth(['business:read']), exportQuery({ fields: 'email' }))).toThrow(
      ForbiddenError,
    );
  });

  it('writes every column, pages to the row cap and audits the export', async () => {
    const { service, audit, calls } = exporter(5, [], 3);
    const q = exportQuery({ sort: '-score' });
    const lines = await collect(service.rows(auth(), q, service.fieldsFor(auth(), q)));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      'id,name,category,website,locality,address,postal_code,country,lat,lng,rating,reviews,status,score,tier,tags,tracked_at,phone,email',
    );
    expect(lines[1]).toBe(
      [
        id(5),
        'Business 5',
        'Spa',
        '',
        'Gustavia',
        '"1 Rue, Gustavia"',
        '97133',
        'BL',
        '17.9',
        '-62.85',
        '4',
        '5',
        'new',
        '5',
        '',
        'vip',
        NOW.toISOString(),
        "'+590590000005",
        'hello@spa.example',
      ].join(','),
    );
    expect(calls.page).toHaveLength(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'business.exported',
        metadata: expect.objectContaining({ rows: 3, sort: '-score' }),
      }),
    );
  });

  it('exports ranked text results in relevance order and refuses impossible sorts', async () => {
    const { service } = exporter(3, [id(3), id(1)]);
    const q = exportQuery({ q: 'spa', fields: 'id' });
    expect(await collect(service.rows(auth(), q, ['id']))).toEqual(['id', id(3), id(1)]);
    const distance = exportQuery({ sort: 'distance' });
    await expect(collect(service.rows(auth(), distance, ['id']))).rejects.toBeInstanceOf(ValidationError);
    expect(csvCell('-1')).toBe("'-1");
  });
});
