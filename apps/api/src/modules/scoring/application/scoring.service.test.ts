import { fixedClock, ScoreUpdated } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { setTransactionalDb } from '../../platform/db/transactional.ts';
import { facts } from '../domain/__fixtures__/facts.ts';
import { BUILTIN_PROFILES } from '../domain/builtin-profiles.ts';
import { BUILTIN_PRIMARY_PROFILE_ID, BUILTIN_PROFILE_IDS } from './builtin-profiles.seeder.ts';
import type { ActiveProfile, ScoreWrite, ScoringRepository } from './ports.ts';
import { ScoringService, vectorHash } from './scoring.service.ts';

const ORG = '01990000-0000-7000-8000-0000000000a1';
const BUSINESS = '01990000-0000-7000-8000-0000000000c1';
const clock = fixedClock('2026-10-14T12:00:00.000Z');

const active = (offer: 'new_website' | 'local_seo'): ActiveProfile => ({
  id: BUILTIN_PROFILE_IDS[offer],
  organizationId: null,
  offer,
  name: offer,
  builtin: true,
  activeVersion: 1,
  config: BUILTIN_PROFILES[offer],
});

function setup(current: Awaited<ReturnType<ScoringRepository['currentScores']>> = new Map()) {
  const writes: ScoreWrite[][] = [];
  const repository = {
    activeProfiles: vi.fn(async () => [active('new_website'), active('local_seo')]),
    primaryProfileId: vi.fn(async () => null),
    currentScores: vi.fn(async () => current),
    writeScores: vi.fn(async (batch: readonly ScoreWrite[]) => {
      writes.push([...batch]);
    }),
  } as unknown as ScoringRepository;
  const noSite = facts({ businessId: BUSINESS, business: { websiteUrl: null }, audit: null, site: null });
  const assembler = { assemble: vi.fn(async () => [noSite]) };
  const events = { record: vi.fn(async () => ({})) };
  const realtime = { publish: vi.fn(async () => ({})) };
  const service = new ScoringService(repository, assembler, clock, events as never, realtime as never);
  return { service, writes, events, realtime, noSite };
}

beforeAll(() => {
  setTransactionalDb({ transaction: (fn: (tx: unknown) => unknown) => fn({}) } as unknown as DbClient);
});

describe('ScoringService', () => {
  it('scores with every active profile, writes them, and tells open pages; a first score is no event', async () => {
    const { service, writes, events, realtime } = setup();
    expect(await service.compute(ORG, [BUSINESS])).toEqual({ scored: 2, written: 2, unchanged: 0 });
    expect(
      writes[0]?.map((write) => [write.profileId, write.featureSetVersion, write.computedAt.toISOString()]),
    ).toEqual([
      [BUILTIN_PROFILE_IDS.new_website, 1, '2026-10-14T12:00:00.000Z'],
      [BUILTIN_PROFILE_IDS.local_seo, 1, '2026-10-14T12:00:00.000Z'],
    ]);
    expect(events.record).not.toHaveBeenCalled();
    expect(realtime.publish).toHaveBeenCalledWith(ORG, {
      type: 'scoring.scores.updated',
      entity: 'business',
      entityId: BUSINESS,
    });
  });

  it('skips unchanged vectors under the same versions, unless forced', async () => {
    const first = setup();
    await first.service.compute(ORG, [BUSINESS]);
    const stored = first.writes[0]?.map((write) => ({
      profileId: write.profileId,
      profileVersion: 1,
      featureSetVersion: 1,
      factsHash: write.factsHash,
      score: write.score,
      tier: write.tier,
    }));
    const again = setup(new Map([[BUSINESS, stored ?? []]]));
    expect(await again.service.compute(ORG, [BUSINESS])).toEqual({ scored: 2, written: 0, unchanged: 2 });
    expect(again.realtime.publish).not.toHaveBeenCalled();
    expect(await again.service.compute(ORG, [BUSINESS], { force: true, notify: false })).toMatchObject({
      written: 2,
    });
    expect(again.realtime.publish).not.toHaveBeenCalled();
    // A newer profile version is not "unchanged".
    const bumped = setup(
      new Map([[BUSINESS, (stored ?? []).map((score) => ({ ...score, profileVersion: 0 }))]]),
    );
    expect(await bumped.service.compute(ORG, [BUSINESS])).toMatchObject({ written: 2 });
  });

  it('records score.updated when the primary profile’s tier moves, and only then', async () => {
    const { service, events } = setup(
      new Map([
        [
          BUSINESS,
          [
            {
              profileId: BUILTIN_PRIMARY_PROFILE_ID,
              profileVersion: 1,
              featureSetVersion: 1,
              factsHash: 'old',
              score: 10,
              tier: 'C',
            },
            {
              profileId: BUILTIN_PROFILE_IDS.local_seo,
              profileVersion: 1,
              featureSetVersion: 1,
              factsHash: 'old',
              score: 10,
              tier: 'C',
            },
          ],
        ],
      ]),
    );
    await service.compute(ORG, [BUSINESS]);
    // new_website moves C → A (no website, busy); local_seo moves too but is not primary.
    expect(events.record).toHaveBeenCalledTimes(1);
    expect(events.record).toHaveBeenCalledWith(
      ScoreUpdated,
      expect.objectContaining({
        orgId: ORG,
        payload: expect.objectContaining({
          businessId: BUSINESS,
          profileId: BUILTIN_PRIMARY_PROFILE_ID,
          previousTier: 'C',
          previousScore: 10,
          primary: true,
        }),
      }),
    );
  });

  it('hashes vectors whatever their key order', () => {
    expect(vectorHash({ has_phone: true, rating_avg: 4 })).toBe(
      vectorHash({ rating_avg: 4, has_phone: true }),
    );
    expect(vectorHash({ has_phone: true })).not.toBe(vectorHash({ has_phone: false }));
  });
});
