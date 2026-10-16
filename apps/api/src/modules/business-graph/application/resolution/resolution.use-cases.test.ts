import {
  ForbiddenError,
  NotFoundError,
  type SourceRecordInput,
  SourceRecordSchema,
  ValidationError,
} from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { createLogger } from '@bf/observability';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../../platform/config/app-env.ts';
import { setTransactionalDb } from '../../../platform/db/transactional.ts';
import type { EventRecorder } from '../../../platform/events/event-recorder.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import type { AuditLogger } from '../../../workspace/index.ts';
import { Business, type BusinessState } from '../../domain/business.entity.ts';
import { BusinessMergedError } from '../../domain/errors.ts';
import type { CandidateProfile } from '../../domain/resolution/match-scorer.ts';
import { type NormalizedSource, normalizeSource } from '../../domain/resolution/normalized-source.ts';
import { BusinessName } from '../../domain/value-objects/business-name.ts';
import type {
  BusinessRepository,
  ContactRecord,
  ContactRepository,
  SourceRecordRepository,
} from '../ports.ts';
import type { CategoryClassifier } from '../taxonomy/category-classifier.ts';
import type { TaxonomyCache, TaxonomySnapshot } from '../taxonomy/taxonomy-cache.ts';
import { GoldenRecordWriter } from './golden-record.writer.ts';
import { IngestBatchCommand } from './ingest-batch.command.ts';
import { IngestSourceRecordCommand } from './ingest-source-record.command.ts';
import {
  ListPossibleDuplicatesQuery,
  MergeBusinessesCommand,
  ResolvePossibleDuplicateCommand,
  SplitBusinessCommand,
} from './merge.commands.ts';
import type { DuplicateRecord, LinkedSource, MergeRepository, ResolutionRepository } from './ports.ts';

const fakeDb = { transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}) } as unknown as DbClient;
beforeAll(() => setTransactionalDb(fakeDb));
afterAll(() => setTransactionalDb(undefined));

const logger = createLogger({ service: 'test', level: 'fatal' });
const env = { RESOLUTION_MATCH_THRESHOLD: 0.85, RESOLUTION_POSSIBLE_THRESHOLD: 0.6 } as AppEnv;
const ORG = '019a0000-0000-7000-8000-00000000000a';
const auth = { orgId: ORG, userId: 'u1', method: 'session', operator: false } as unknown as AuthContext;
const id = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const record = (overrides: Partial<SourceRecordInput> = {}): SourceRecordInput => ({
  provider: 'google_places',
  providerRef: 'g-1',
  fetchedAt: '2026-10-01T10:00:00.000Z',
  name: 'Le Tamarin',
  providerCategories: [{ key: 'restaurant' }],
  location: { lat: 17.9, lng: -62.85 },
  address: { countryCode: 'BL', city: 'Saint-Jean' },
  phones: ['0590 27 00 01'],
  ...overrides,
});
const normalized = (overrides: Partial<SourceRecordInput> = {}) =>
  normalizeSource(SourceRecordSchema.parse(record(overrides)));

const snapshot = {
  bySlug: new Map([['restaurant', { id: id(900), slug: 'restaurant', path: 'food_drink.restaurant' }]]),
} as unknown as TaxonomySnapshot;
const taxonomy = { get: async () => snapshot } as unknown as TaxonomyCache;

function ingestHarness(
  options: {
    existing?: LinkedSource;
    candidates?: CandidateProfile[];
    mergedInto?: Record<string, string | null>;
    ownTracked?: string[];
  } = {},
) {
  const calls: string[] = [];
  const resolution = {
    findSource: vi.fn(async () => options.existing),
    touchSource: vi.fn(async () => calls.push('touch')),
    lockKeys: vi.fn(async (keys: string[]) => calls.push(`lock:${keys.length}`)),
    findCandidateIds: vi.fn(async () => (options.candidates ?? []).map((c) => c.businessId)),
    loadProfiles: vi.fn(async (ids: string[]) =>
      (options.candidates ?? []).filter((c) => ids.includes(c.businessId)),
    ),
    linkSource: vi.fn(async (_s: string, businessId: string, confidence: number) =>
      calls.push(`link:${businessId}:${confidence}`),
    ),
    listLinkedSources: vi.fn(async () => [{ id: 's1', normalized: normalized() }]),
    recordPossibleDuplicate: vi.fn(async (a: string, b: string) => calls.push(`dup:${a}:${b}`)),
    mergedInto: vi.fn(async (bid: string) =>
      options.mergedInto?.[bid] === undefined ? null : options.mergedInto[bid],
    ),
    trackedOnlyBy: vi.fn(
      async (_org: string, ids: string[]) => new Set(ids.filter((i) => options.ownTracked?.includes(i))),
    ),
  } as unknown as ResolutionRepository;
  const sources = {
    upsert: vi.fn(async (r: { id: string; businessId: string | null }) => ({
      record: { ...r, businessId: options.existing?.businessId ?? null },
      changed: true,
    })),
  } as unknown as SourceRecordRepository;
  const writer = {
    write: vi.fn(async (businessId: string, _s: unknown, o: { create: boolean }) =>
      calls.push(`write:${businessId}:${o.create}`),
    ),
  } as unknown as GoldenRecordWriter;
  const classifier = {
    classify: vi.fn(async () => ({ primary: 'restaurant', secondary: [], confidence: 0.9 })),
  } as unknown as CategoryClassifier;
  const command = new IngestSourceRecordCommand(
    resolution,
    sources,
    fakeDb,
    logger,
    env,
    writer,
    classifier,
    taxonomy,
  );
  return { command, resolution, sources, writer, classifier, calls };
}

const profileOf = (businessId: string, overrides: Partial<CandidateProfile> = {}): CandidateProfile => ({
  businessId,
  normalizedName: 'le tamarin',
  location: { lat: 17.9, lng: -62.85 },
  phones: ['+590590270001'],
  siteKeys: [],
  categoryPath: 'food_drink.restaurant',
  addressTokens: [],
  sources: [{ provider: 'overture', providerRef: 'o-1' }],
  ...overrides,
});

describe('IngestSourceRecordCommand', () => {
  it('rejects invalid records with a validation error', async () => {
    const { command } = ingestHarness();
    await expect(command.execute({ ...record(), name: ' ' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('only refreshes the fetch time for unchanged content', async () => {
    // Compute the hash the command uses by letting it store once.
    const first = ingestHarness();
    await first.command.execute(record());
    const hash = (first.sources.upsert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].contentHash as string;
    const unchanged = ingestHarness({
      existing: { id: 's9', businessId: id(1), contentHash: hash, normalized: null },
    });
    const result = await unchanged.command.execute({ ...record(), fetchedAt: '2026-10-09T00:00:00.000Z' });
    expect(result).toEqual({
      outcome: 'unchanged',
      businessId: id(1),
      sourceId: 's9',
      possibleDuplicates: [],
    });
    expect(unchanged.calls).toEqual(['touch']);
    expect(unchanged.classifier.classify).not.toHaveBeenCalled();
  });

  it('creates a business when nothing matches, classifying with French hints for BL', async () => {
    const { command, calls, classifier } = ingestHarness();
    const result = await command.execute(record(), { orgId: ORG });
    expect(result.outcome).toBe('created');
    expect(calls[0]).toMatch(/^lock:\d+$/);
    expect(calls.slice(1)).toEqual([`write:${result.businessId}:true`, `link:${result.businessId}:1`]);
    expect(classifier.classify).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: 'fr',
        orgId: ORG,
        useModel: true,
        providerCategories: [{ provider: 'google_places', key: 'restaurant' }],
      }),
    );
  });

  it('merges into a matching candidate and recomputes it', async () => {
    const { command, calls } = ingestHarness({ candidates: [profileOf(id(2))] });
    const result = await command.execute(
      record({ provider: 'website', providerRef: 'https://x.example.com' }),
      {
        classifyWithModel: false,
      },
    );
    expect(result).toMatchObject({ outcome: 'merged', businessId: id(2) });
    expect(result.score?.total).toBeGreaterThanOrEqual(0.85);
    expect(calls.slice(1)).toEqual([
      'lock:1',
      expect.stringMatching(new RegExp(`^link:${id(2)}:`)),
      `write:${id(2)}:false`,
    ]);
  });

  it('follows a merge that retired the candidate while waiting for its lock', async () => {
    const { command, calls } = ingestHarness({
      candidates: [profileOf(id(2))],
      mergedInto: { [id(2)]: id(8) },
    });
    const result = await command.execute(
      record({ provider: 'website', providerRef: 'https://x.example.com' }),
    );
    expect(result).toMatchObject({ outcome: 'merged', businessId: id(8) });
    expect(calls).toContain(`write:${id(8)}:false`);
  });

  it('lets a manual add join only records the workspace alone tracks', async () => {
    const shared = ingestHarness({ candidates: [profileOf(id(2))] });
    const created = await shared.command.execute(record({ provider: 'manual', providerRef: 'm-9' }), {
      orgId: ORG,
    });
    expect(created.outcome).not.toBe('merged');
    const own = ingestHarness({ candidates: [profileOf(id(2))], ownTracked: [id(2)] });
    const merged = await own.command.execute(record({ provider: 'manual', providerRef: 'm-9' }), {
      orgId: ORG,
    });
    expect(merged).toMatchObject({ outcome: 'merged', businessId: id(2) });
  });

  it('flags a possible duplicate and still creates', async () => {
    const lookAlike = profileOf(id(3), { phones: [], location: { lat: 17.9003, lng: -62.85 } });
    const { command, calls } = ingestHarness({ candidates: [lookAlike] });
    const result = await command.execute(record({ phones: [] }));
    expect(result).toMatchObject({ outcome: 'possible_duplicate', possibleDuplicates: [id(3)] });
    expect(calls).toContain(`dup:${result.businessId}:${id(3)}`);
  });

  it('recomputes the linked business when a known record changes', async () => {
    const { command, calls } = ingestHarness({
      existing: { id: 's1', businessId: id(4), contentHash: 'old', normalized: null },
    });
    const result = await command.execute(record({ provider: 'manual', providerRef: 'm-1' }), { orgId: ORG });
    expect(result).toEqual({ outcome: 'merged', businessId: id(4), sourceId: 's1', possibleDuplicates: [] });
    expect(calls).toContain(`write:${id(4)}:false`);
  });

  it('sends no provider categories for non-taxonomy providers', async () => {
    const { command, classifier } = ingestHarness();
    await command.execute(record({ provider: 'gmaps_scraper', address: undefined }), { defaultRegion: 'US' });
    expect(classifier.classify).toHaveBeenCalledWith(
      expect.objectContaining({ providerCategories: [], locale: 'en' }),
    );
  });
});

describe('IngestBatchCommand', () => {
  it('counts outcomes and isolates failures', async () => {
    const ingest = {
      execute: vi.fn(async (r: SourceRecordInput) => {
        if (r.providerRef === 'bad') throw new ValidationError('nope');
        if (r.providerRef === 'boom') throw new Error('database down');
        return {
          outcome: r.providerRef === 'g-1' ? 'created' : 'unchanged',
          businessId: id(1),
          sourceId: 's',
          possibleDuplicates: [],
        };
      }),
    } as unknown as IngestSourceRecordCommand;
    const result = await new IngestBatchCommand(ingest, logger).execute([
      record(),
      record({ providerRef: 'bad' }),
      record({ providerRef: 'boom' }),
      record({ providerRef: 'g-2' }),
    ]);
    expect(result.counts).toEqual({ created: 1, merged: 0, possible_duplicate: 0, unchanged: 1, failed: 2 });
    expect(result.results[1]).toEqual({ outcome: 'failed', providerRef: 'bad', code: 'VALIDATION_FAILED' });
    expect(result.results[2]).toEqual({ outcome: 'failed', providerRef: 'boom', code: 'INTERNAL' });
  });
});

describe('GoldenRecordWriter', () => {
  function writerHarness(existing?: Business, contacts: ContactRecord[] = []) {
    const saved: Business[] = [];
    const businesses = {
      getById: vi.fn(async () => existing),
      save: vi.fn(async (b: Business) => {
        saved.push(b);
        b.markSaved(b.version + 1);
      }),
    } as unknown as BusinessRepository;
    const contactRepo = { listByBusiness: vi.fn(async () => contacts) } as unknown as ContactRepository;
    const resolution = {
      deleteDerivedContactsExcept: vi.fn(async () => 1),
      replaceCategories: vi.fn(async () => true),
      replaceHours: vi.fn(async () => false),
    } as unknown as ResolutionRepository;
    const recorded: string[] = [];
    const events = {
      record: vi.fn(async (d: { type: string }) => recorded.push(d.type)),
    } as unknown as EventRecorder;
    return {
      writer: new GoldenRecordWriter(businesses, contactRepo, resolution, taxonomy, events),
      saved,
      recorded,
      resolution,
    };
  }

  it('creates a business from its sources with contacts and categories', async () => {
    const { writer, saved, recorded, resolution } = writerHarness();
    const source: NormalizedSource = {
      ...normalized({ emails: ['info@le-tamarin.com'] }),
      categories: { primary: 'restaurant', secondary: ['unknown_slug'], confidence: 0.9 },
    };
    const business = await writer.write(id(5), [source], { create: true });
    expect(business.snapshot()).toMatchObject({
      displayName: 'Le Tamarin',
      primaryCategoryId: id(900),
      countryCode: 'BL',
    });
    expect(saved).toHaveLength(1);
    expect(recorded).toEqual(['business.created']);
    expect(resolution.replaceCategories).toHaveBeenCalledWith(id(5), [
      { categoryId: id(900), isPrimary: true, confidence: 0.9, source: 'google_places' },
    ]);
    expect(resolution.deleteDerivedContactsExcept).not.toHaveBeenCalled();
  });

  it('recomputes an existing business, removing stale derived contacts', async () => {
    const state: BusinessState = {
      ...Business.create({
        id: id(6),
        name: BusinessName.parse('Old'),
        countryCode: 'BL',
        provenance: { source: 'osm', sourceRef: 'n', confidence: 0.7, observedAt: new Date('2026-01-01') },
      }).snapshot(),
      version: 1,
    };
    const existing = Business.rehydrate(state);
    const phone = {
      type: 'phone',
      normalizedValue: '+590590270001',
      publishedOnSite: false,
      confidence: 0.9,
    } as unknown as ContactRecord;
    const { writer, recorded } = writerHarness(existing, [phone]);
    const business = await writer.write(id(6), [normalized()], { create: false });
    expect(business.snapshot().displayName).toBe('Le Tamarin');
    expect(recorded).toEqual(['business.updated']);
  });

  it('refuses to recompute a missing business or create one without sources', async () => {
    await expect(writerHarness().writer.write(id(7), [normalized()], { create: false })).rejects.toThrow(
      /not found/,
    );
    await expect(writerHarness().writer.write(id(7), [], { create: true })).rejects.toThrow();
  });
});

describe('merge commands', () => {
  const live = (n: number, mergedInto: string | null = null) =>
    Business.rehydrate({
      ...Business.create({
        id: id(n),
        name: BusinessName.parse(`B${n}`),
        countryCode: null,
        provenance: { source: 'osm', sourceRef: 'n', confidence: 0.7, observedAt: new Date('2026-01-01') },
      }).snapshot(),
      version: 1,
      mergedIntoId: mergedInto,
    });

  function mergeHarness(
    options: {
      tracked?: string[];
      shared?: string[];
      businesses?: Business[];
      sources?: Array<{ id: string; hasNormalized: boolean }>;
      duplicate?: DuplicateRecord;
    } = {},
  ) {
    const merges = {
      trackedBy: vi.fn(
        async (_org: string, ids: string[]) =>
          new Set(ids.filter((i) => (options.tracked ?? ids).includes(i))),
      ),
      trackedByOthers: vi.fn(
        async (_org: string, ids: string[]) => new Set(ids.filter((i) => options.shared?.includes(i))),
      ),
      moveSources: vi.fn(async () => 1),
      moveSideData: vi.fn(async () => undefined),
      mergeOrgLinks: vi.fn(async () => []),
      repointDuplicates: vi.fn(async () => undefined),
      listSources: vi.fn(async () => options.sources ?? []),
      copyOrgLinks: vi.fn(async () => undefined),
      getDuplicate: vi.fn(async () => options.duplicate),
      setDuplicateStatus: vi.fn(async () => undefined),
      listDuplicates: vi.fn(async () => (options.duplicate ? [options.duplicate] : [])),
      businessLabels: vi.fn(async () => new Map([[id(1), { displayName: 'B1', locality: null }]])),
    } as unknown as MergeRepository;
    const businesses = {
      getByIds: vi.fn(async (ids: string[]) => (options.businesses ?? []).filter((b) => ids.includes(b.id))),
      getById: vi.fn(async (bid: string) => (options.businesses ?? []).find((b) => b.id === bid)),
      save: vi.fn(async () => undefined),
    } as unknown as BusinessRepository;
    const resolution = {
      lockKeys: vi.fn(async () => undefined),
      listLinkedSources: vi.fn(async () =>
        (options.sources ?? []).map((s) => ({ id: s.id, normalized: normalized() })),
      ),
    } as unknown as ResolutionRepository;
    const writer = { write: vi.fn(async () => undefined) } as unknown as GoldenRecordWriter;
    const events = { record: vi.fn(async () => undefined) } as unknown as EventRecorder;
    const audit = { record: vi.fn(async () => undefined) } as unknown as AuditLogger;
    const merge = new MergeBusinessesCommand(businesses, merges, resolution, writer, events, audit);
    return {
      merge,
      split: new SplitBusinessCommand(businesses, merges, resolution, writer, audit),
      list: new ListPossibleDuplicatesQuery(merges),
      resolve: new ResolvePossibleDuplicateCommand(merges, merge, audit),
      merges,
      writer,
    };
  }

  it('merges tracked live businesses and recomputes the survivor', async () => {
    const h = mergeHarness({ businesses: [live(1), live(2)], sources: [{ id: 's1', hasNormalized: true }] });
    const result = await h.merge.execute(auth, { survivorId: id(1) as never, mergedIds: [id(2) as never] });
    expect(result).toEqual({ survivorId: id(1), mergedIds: [id(2)], sourcesMoved: 1 });
    expect(h.writer.write).toHaveBeenCalledWith(
      id(1),
      expect.any(Array),
      expect.objectContaining({ create: false }),
    );
  });

  it('refuses to merge or split records other workspaces track, unless an operator does it', async () => {
    const h = mergeHarness({
      businesses: [live(1), live(2)],
      shared: [id(2)],
      sources: [{ id: 's1', hasNormalized: true }],
    });
    const request = { survivorId: id(1) as never, mergedIds: [id(2) as never] };
    await expect(h.merge.execute(auth, request)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(h.split.execute(auth, id(2), { sourceIds: ['s1'] })).rejects.toBeInstanceOf(ForbiddenError);
    const operator = { ...auth, operator: true } as AuthContext;
    await expect(h.merge.execute(operator, request)).resolves.toMatchObject({ survivorId: id(1) });
  });

  it('refuses untracked, missing and merged businesses', async () => {
    await expect(
      mergeHarness({ tracked: [id(1)], businesses: [live(1), live(2)] }).merge.execute(auth, {
        survivorId: id(1) as never,
        mergedIds: [id(2) as never],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      mergeHarness({ businesses: [live(1)] }).merge.execute(auth, {
        survivorId: id(1) as never,
        mergedIds: [id(2) as never],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      mergeHarness({ businesses: [live(1), live(2, id(9))] }).merge.execute(auth, {
        survivorId: id(1) as never,
        mergedIds: [id(2) as never],
      }),
    ).rejects.toBeInstanceOf(BusinessMergedError);
  });

  it('splits sources off into a new business, validating the request', async () => {
    const sources = [
      { id: 's1', hasNormalized: true },
      { id: 's2', hasNormalized: true },
    ];
    const ok = mergeHarness({ businesses: [live(1)], sources });
    const result = await ok.split.execute(auth, id(1), { sourceIds: ['s2'] });
    expect(result).toMatchObject({ businessId: id(1), sourcesMoved: 1 });
    expect(ok.writer.write).toHaveBeenCalledTimes(2);
    await expect(
      mergeHarness({ businesses: [live(1)], sources }).split.execute(auth, id(1), {
        sourceIds: ['s1', 's2'],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      mergeHarness({ businesses: [live(1)], sources }).split.execute(auth, id(1), { sourceIds: ['x'] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      mergeHarness({ businesses: [], sources }).split.execute(auth, id(1), { sourceIds: ['s1'] }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      mergeHarness({ businesses: [live(1, id(9))], sources }).split.execute(auth, id(1), {
        sourceIds: ['s1'],
      }),
    ).rejects.toBeInstanceOf(BusinessMergedError);
  });

  const duplicate = (status: DuplicateRecord['status'] = 'open'): DuplicateRecord => ({
    id: id(50),
    businessAId: id(1),
    businessBId: id(2),
    score: 0.7,
    reasons: { total: 0.7, features: [], reasons: ['name similarity 0.9'] },
    status,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    createdAtText: '2026-10-01T00:00:00.000000Z',
  });

  it('lists duplicates with labels and validates cursors', async () => {
    const h = mergeHarness({ duplicate: duplicate() });
    const page = await h.list.execute(auth, { status: 'open', limit: 50 });
    expect(page.items[0]).toMatchObject({
      id: id(50),
      businessA: { id: id(1), displayName: 'B1' },
      businessB: { displayName: '' },
    });
    expect(page.nextCursor).toBeNull();
    await expect(
      h.list.execute(auth, { status: 'open', limit: 50, cursor: 'garbage' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('resolves duplicates: dismiss, merge, and refusals', async () => {
    const dismiss = mergeHarness({ duplicate: duplicate() });
    await dismiss.resolve.execute(auth, id(50), { action: 'dismiss' });
    expect(dismiss.merges.setDuplicateStatus).toHaveBeenCalledWith(id(50), 'dismissed');
    const merge = mergeHarness({ duplicate: duplicate(), businesses: [live(1), live(2)] });
    await merge.resolve.execute(auth, id(50), { action: 'merge', survivorId: id(2) as never });
    expect(merge.merges.setDuplicateStatus).toHaveBeenCalledWith(id(50), 'merged');
    await expect(mergeHarness().resolve.execute(auth, id(50), { action: 'dismiss' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      mergeHarness({ duplicate: duplicate(), tracked: [id(1)] }).resolve.execute(auth, id(50), {
        action: 'dismiss',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      mergeHarness({ duplicate: duplicate('dismissed') }).resolve.execute(auth, id(50), {
        action: 'dismiss',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      mergeHarness({ duplicate: duplicate() }).resolve.execute(auth, id(50), {
        action: 'merge',
        survivorId: id(7) as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
