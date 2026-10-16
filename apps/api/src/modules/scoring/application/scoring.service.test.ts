import { fixedClock, type ScoreTier, ScoreUpdated } from '@bf/contracts';
import { type DbClient } from '@bf/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTransactionalDb } from '../../platform/db/transactional.ts';
import { facts } from '../domain/__fixtures__/facts.ts';
import { BUILTIN_PROFILES } from '../domain/builtin-profiles.ts';
import { BUILTIN_PRIMARY_PROFILE_ID, BUILTIN_PROFILE_IDS } from './builtin-profiles.seeder.ts';
import type { ActiveProfile, ScoreWriteRequest, ScoringRepository } from './ports.ts';
import { ScoringService, vectorHash } from './scoring.service.ts';

const ORG = '01990000-0000-7000-8000-0000000000a1';
const BUSINESS = '01990000-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-10-14T12:00:00.000Z');

const active = (offer: 'new_website' | 'local_seo'): ActiveProfile => ({
  id: BUILTIN_PROFILE_IDS[offer],
  organizationId: null,
  offer,
  name: offer,
  builtin: true,
  activeVersion: 1,
  config: BUILTIN_PROFILES[offer],
});

interface Stored {
  profileId: string;
  profileVersion: number;
  featureSetVersion: number;
  factsHash: string;
  score: number;
  tier: ScoreTier;
  computedAt: Date;
}
const stored = (overrides: Partial<Stored> & Pick<Stored, 'profileId'>): Stored => ({
  profileVersion: 1,
  featureSetVersion: 1,
  factsHash: 'old',
  score: 10,
  tier: 'C',
  computedAt: new Date('2026-10-13T12:00:00.000Z'),
  ...overrides,
});

function setup(current: Map<string, Stored[]> = new Map(), versions: Record<string, number> = {}) {
  const writes: ScoreWriteRequest[][] = [];
  const repository = {
    activeProfiles: vi.fn(async () => [active('new_website'), active('local_seo')]),
    primaryProfileId: vi.fn(async () => null),
    lockBusinesses: vi.fn(async (_org: string, ids: readonly string[]) => new Set(ids)),
    activeVersions: vi.fn(
      async (ids: readonly string[]) => new Map(ids.map((id) => [id, versions[id] ?? 1] as const)),
    ),
    databaseNow: vi.fn(async () => NOW),
    currentScores: vi.fn(async () => current),
    writeScores: vi.fn(async (batch: readonly ScoreWriteRequest[]) => {
      writes.push([...batch]);
    }),
  } as unknown as ScoringRepository;
  const assembler = {
    assemble: vi.fn(async (_org: string, ids: readonly string[]) =>
      ids.map((id) => facts({ businessId: id, business: { websiteUrl: null }, audit: null, site: null })),
    ),
  };
  const events = { record: vi.fn(async () => ({})) };
  const realtime = { publish: vi.fn(async () => ({})) };
  const service = new ScoringService(repository, assembler, events as never, realtime as never);
  return { service, writes, events, realtime, repository, assembler };
}

beforeAll(() => {
  setTransactionalDb({ transaction: (fn: (tx: unknown) => unknown) => fn({}) } as unknown as DbClient);
});
afterAll(() => setTransactionalDb(undefined));

describe('ScoringService', () => {
  it('scores with every active profile under the businesses’ locks, writes history, tells open pages', async () => {
    const { service, writes, events, realtime, repository } = setup();
    expect(await service.compute(ORG, [BUSINESS])).toEqual({ scored: 2, written: 2, unchanged: 0 });
    expect(repository.lockBusinesses).toHaveBeenCalledWith(ORG, [BUSINESS]);
    expect(
      writes[0]?.map((write) => [write.profileId, write.history, write.computedAt.toISOString()]),
    ).toEqual([
      [BUILTIN_PROFILE_IDS.new_website, true, NOW.toISOString()],
      [BUILTIN_PROFILE_IDS.local_seo, true, NOW.toISOString()],
    ]);
    // A first score is no event.
    expect(events.record).not.toHaveBeenCalled();
    expect(realtime.publish).toHaveBeenCalledWith(ORG, {
      type: 'scoring.scores.updated',
      entity: 'business',
      entityId: BUSINESS,
    });
  });

  it('skips unchanged vectors; a forced run rewrites the current row without new history', async () => {
    const first = setup();
    await first.service.compute(ORG, [BUSINESS]);
    const same = (first.writes[0] ?? []).map((write) =>
      stored({
        profileId: write.profileId,
        factsHash: write.factsHash,
        score: write.score,
        tier: write.tier,
      }),
    );
    const again = setup(new Map([[BUSINESS, same]]));
    expect(await again.service.compute(ORG, [BUSINESS])).toEqual({ scored: 2, written: 0, unchanged: 2 });
    expect(again.realtime.publish).not.toHaveBeenCalled();
    expect(await again.service.compute(ORG, [BUSINESS], { force: true, notify: false })).toMatchObject({
      written: 2,
    });
    expect(again.writes[0]?.map((write) => write.history)).toEqual([false, false]);
    expect(again.realtime.publish).not.toHaveBeenCalled();
    // A newer profile or feature-set version is a new fingerprint.
    const bumped = setup(new Map([[BUSINESS, same.map((score) => ({ ...score, featureSetVersion: 0 }))]]));
    await bumped.service.compute(ORG, [BUSINESS]);
    expect(bumped.writes[0]?.map((write) => write.history)).toEqual([true, true]);
  });

  it('drops a write of a version no longer active (the job started before an activation)', async () => {
    const { service, writes } = setup(new Map(), { [BUILTIN_PRIMARY_PROFILE_ID]: 2 });
    expect(await service.compute(ORG, [BUSINESS])).toMatchObject({ written: 1, unchanged: 1 });
    expect(writes[0]?.map((write) => write.profileId)).toEqual([BUILTIN_PROFILE_IDS.local_seo]);
  });

  it('lets the active version win over the stored one, whatever the numbers and times', async () => {
    // A newer version computed earlier than a stale v1 row written later: the active version is written.
    const later = new Date(NOW.getTime() + 60_000);
    const upgraded = setup(
      new Map([
        [BUSINESS, [stored({ profileId: BUILTIN_PRIMARY_PROFILE_ID, profileVersion: 1, computedAt: later })]],
      ]),
      { [BUILTIN_PRIMARY_PROFILE_ID]: 2 },
    );
    // (The profile's own config is v1's here; only the version number matters for the guard.)
    (upgraded.repository.activeProfiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { ...active('new_website'), activeVersion: 2 },
    ]);
    expect(await upgraded.service.compute(ORG, [BUSINESS])).toMatchObject({ written: 1 });
    // A rollback to v1 is written over the stored v2.
    const rolledBack = setup(
      new Map([[BUSINESS, [stored({ profileId: BUILTIN_PRIMARY_PROFILE_ID, profileVersion: 2 })]]]),
    );
    (rolledBack.repository.activeProfiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      active('new_website'),
    ]);
    expect(await rolledBack.service.compute(ORG, [BUSINESS])).toMatchObject({ written: 1 });
  });

  it('never writes over a newer feature set or a later computation of the same version', async () => {
    const { service, writes } = setup(
      new Map([
        [
          BUSINESS,
          [
            stored({ profileId: BUILTIN_PRIMARY_PROFILE_ID, featureSetVersion: 2 }),
            stored({ profileId: BUILTIN_PROFILE_IDS.local_seo, computedAt: new Date(NOW.getTime() + 1_000) }),
          ],
        ],
      ]),
    );
    expect(await service.compute(ORG, [BUSINESS], { force: true })).toMatchObject({
      written: 0,
      unchanged: 2,
    });
    expect(writes).toEqual([]);
  });

  it('writes nothing for a business no longer tracked (not locked)', async () => {
    const { service, repository, writes } = setup();
    (repository.lockBusinesses as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Set());
    expect(await service.compute(ORG, [BUSINESS])).toMatchObject({ written: 0, unchanged: 2 });
    expect(writes).toEqual([]);
  });

  it('records score.updated when the primary profile’s tier moves, with old and new values', async () => {
    const { service, events } = setup(
      new Map([
        [
          BUSINESS,
          [
            stored({ profileId: BUILTIN_PRIMARY_PROFILE_ID }),
            stored({ profileId: BUILTIN_PROFILE_IDS.local_seo }),
          ],
        ],
      ]),
    );
    await service.compute(ORG, [BUSINESS]);
    // new_website moves C → A (no website, busy); local_seo moves too but is not primary.
    expect(events.record).toHaveBeenCalledExactlyOnceWith(
      ScoreUpdated,
      expect.objectContaining({
        orgId: ORG,
        payload: expect.objectContaining({
          businessId: BUSINESS,
          profileId: BUILTIN_PRIMARY_PROFILE_ID,
          offer: 'new_website',
          tier: 'A',
          score: expect.any(Number),
          previousTier: 'C',
          previousScore: 10,
          primary: true,
        }),
      }),
    );
  });

  it('assembles and writes in batches of 500', async () => {
    const { service, assembler, writes } = setup();
    const ids = Array.from(
      { length: 1_001 },
      (_, i) => `01990000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(await service.compute(ORG, ids, { notify: false })).toMatchObject({
      scored: 2_002,
      written: 2_002,
    });
    expect(assembler.assemble.mock.calls.map((call) => call[1].length)).toEqual([500, 500, 1]);
    expect(writes).toHaveLength(3);
  });

  it('hashes vectors whatever their key order', () => {
    expect(vectorHash({ has_phone: true, rating_avg: 4 })).toBe(
      vectorHash({ rating_avg: 4, has_phone: true }),
    );
    expect(vectorHash({ has_phone: true })).not.toBe(vectorHash({ has_phone: false }));
  });
});
