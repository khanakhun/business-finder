import { createHash } from 'node:crypto';
import {
  type Clock,
  FEATURE_SET_VERSION,
  type FeatureVector,
  SCORING_SCORES_UPDATED,
  ScoreUpdated,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import { RealtimePublisher } from '../../realtime/index.ts';
import { scoreBusiness } from '../domain/engine.ts';
import { BUILTIN_PRIMARY_PROFILE_ID } from './builtin-profiles.seeder.ts';
import {
  type ActiveProfile,
  FACTS_ASSEMBLER,
  type FactsAssembler,
  SCORING_REPOSITORY,
  type ScoreWrite,
  type ScoringRepository,
} from './ports.ts';

/** Businesses assembled and written per batch (≤ 3 fact queries and one write transaction each). */
export const SCORING_BATCH = 500;

/** Stable digest of a feature vector (keys sorted): an unchanged vector is not written again. */
export function vectorHash(features: FeatureVector): string {
  const sorted = Object.fromEntries(Object.entries(features).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export interface ComputeOutcome {
  readonly scored: number;
  readonly written: number;
  readonly unchanged: number;
}

/**
 * Computes scores (BF-031): facts in bulk, every active profile of the workspace (or the given ones) in memory,
 * then one transaction per batch writes the scores that changed — current row, history, the listing's denormalized
 * score for the primary profile — and records `score.updated` when the primary profile's tier moves (the
 * tier the listing and the timeline show; other profiles' scores are read on the business page). Idempotent: an
 * unchanged feature vector under the same profile and feature-set versions is skipped.
 */
@Injectable()
export class ScoringService {
  constructor(
    @Inject(SCORING_REPOSITORY) private readonly repository: ScoringRepository,
    @Inject(FACTS_ASSEMBLER) private readonly assembler: FactsAssembler,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: EventRecorder,
    private readonly realtime: RealtimePublisher,
  ) {}

  /** The workspace's primary profile (its own choice, else the built-in new-website profile). */
  async primaryProfileId(organizationId: string): Promise<string> {
    return (await this.repository.primaryProfileId(organizationId)) ?? BUILTIN_PRIMARY_PROFILE_ID;
  }

  async compute(
    organizationId: string,
    businessIds: readonly string[],
    options: {
      readonly profileIds?: readonly string[];
      readonly force?: boolean;
      /** Tell open pages per business (off for bulk recomputes, which report progress instead). */
      readonly notify?: boolean;
    } = {},
  ): Promise<ComputeOutcome> {
    const all = await this.repository.activeProfiles(organizationId);
    const profiles = options.profileIds
      ? all.filter((profile) => options.profileIds?.includes(profile.id))
      : all;
    const primary = await this.primaryProfileId(organizationId);
    let outcome: ComputeOutcome = { scored: 0, written: 0, unchanged: 0 };
    for (let start = 0; start < businessIds.length; start += SCORING_BATCH) {
      const batch = await this.batch(
        organizationId,
        businessIds.slice(start, start + SCORING_BATCH),
        profiles,
        primary,
        options,
      );
      outcome = {
        scored: outcome.scored + batch.scored,
        written: outcome.written + batch.written,
        unchanged: outcome.unchanged + batch.unchanged,
      };
    }
    return outcome;
  }

  private async batch(
    organizationId: string,
    businessIds: readonly string[],
    profiles: readonly ActiveProfile[],
    primary: string,
    options: { readonly force?: boolean; readonly notify?: boolean },
  ): Promise<ComputeOutcome> {
    const force = options.force ?? false;
    const now = this.clock.now();
    const facts = await this.assembler.assemble(organizationId, businessIds, now);
    const current = await this.repository.currentScores(organizationId, businessIds);
    const writes: ScoreWrite[] = [];
    const previous = new Map<string, { score: number; tier: ScoreWrite['tier'] }>();
    let unchanged = 0;
    for (const business of facts) {
      for (const profile of profiles) {
        const result = scoreBusiness(profile.config, business);
        const factsHash = vectorHash(result.features);
        const stored = current.get(business.businessId)?.find((score) => score.profileId === profile.id);
        if (
          !force &&
          stored?.profileVersion === profile.activeVersion &&
          stored.featureSetVersion === FEATURE_SET_VERSION &&
          stored.factsHash === factsHash
        ) {
          unchanged += 1;
          continue;
        }
        if (stored)
          previous.set(`${business.businessId}:${profile.id}`, { score: stored.score, tier: stored.tier });
        writes.push({
          ...result,
          organizationId,
          businessId: business.businessId,
          profileId: profile.id,
          profileVersion: profile.activeVersion,
          featureSetVersion: FEATURE_SET_VERSION,
          factsHash,
          computedAt: now,
        });
      }
    }
    await this.write(writes, previous, profiles, primary);
    // After the commit: pages showing these businesses refetch their scores (best effort, like all realtime).
    if (options.notify !== false) {
      for (const businessId of new Set(writes.map((write) => write.businessId))) {
        await this.realtime.publish(organizationId, {
          type: SCORING_SCORES_UPDATED,
          entity: 'business',
          entityId: businessId,
        });
      }
    }
    return { scored: facts.length * profiles.length, written: writes.length, unchanged };
  }

  @Transactional()
  private async write(
    writes: readonly ScoreWrite[],
    previous: ReadonlyMap<string, { score: number; tier: ScoreWrite['tier'] }>,
    profiles: readonly ActiveProfile[],
    primary: string,
  ): Promise<void> {
    if (writes.length === 0) return;
    await this.repository.writeScores(writes, primary);
    const offerOf = new Map(profiles.map((profile) => [profile.id, profile.offer]));
    for (const write of writes) {
      if (write.profileId !== primary) continue;
      const before = previous.get(`${write.businessId}:${write.profileId}`) ?? null;
      // A first score is no change (a bulk first scoring would flood the outbox).
      if (!before || before.tier === write.tier) continue;
      await this.events.record(ScoreUpdated, {
        orgId: write.organizationId,
        actor: { type: 'job', id: 'scoring' },
        payload: {
          businessId: write.businessId,
          profileId: write.profileId,
          profileVersion: write.profileVersion,
          offer: offerOf.get(write.profileId) ?? 'new_website',
          score: write.score,
          tier: write.tier,
          previousScore: before?.score ?? null,
          previousTier: before?.tier ?? null,
          primary: write.profileId === primary,
        },
      });
    }
  }
}
