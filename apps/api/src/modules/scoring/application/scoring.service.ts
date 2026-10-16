import { createHash } from 'node:crypto';
import { FEATURE_SET_VERSION, type FeatureVector, SCORING_SCORES_UPDATED, ScoreUpdated } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
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
  type ScoreWriteRequest,
  type ScoringRepository,
} from './ports.ts';

/** Above this many businesses in a batch, pages hear one workspace-wide refresh instead of one per business. */
const NOTIFY_EACH_UP_TO = 20;

const profileOffer = (offers: ReadonlyMap<string, ActiveProfile['offer']>, profileId: string) => {
  const offer = offers.get(profileId);
  if (!offer) throw new Error(`Scored profile ${profileId} is not among the active profiles`);
  return offer;
};

/** Businesses assembled and written per batch (≤ 3 fact queries and one write transaction each). */
export const SCORING_BATCH = 500;

/** Stable digest of a feature vector (keys sorted): an unchanged vector is not written again. */
export function vectorHash(features: FeatureVector): string {
  const sorted = Object.fromEntries(
    Object.entries(features).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
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
    let outcome: ComputeOutcome = { scored: 0, written: 0, unchanged: 0 };
    // Sorted: every job takes the businesses' locks in the same order.
    const ids = [...new Set(businessIds)].sort();
    for (let start = 0; start < ids.length; start += SCORING_BATCH) {
      const batch = await this.batch(
        organizationId,
        ids.slice(start, start + SCORING_BATCH),
        profiles,
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
    options: { readonly force?: boolean; readonly notify?: boolean },
  ): Promise<ComputeOutcome> {
    // One clock for every process (the database's), taken before the facts: it orders concurrent writes and is the
    // facts' point in time (time-based features agree across processes).
    const computedAt = await this.repository.databaseNow();
    const facts = await this.assembler.assemble(organizationId, businessIds, computedAt);
    // The engine is pure: score everything first, then decide and write under the businesses' locks.
    const scored = facts.flatMap((business) =>
      profiles.map((profile) => {
        const result = scoreBusiness(profile.config, business);
        return {
          profile,
          write: {
            ...result,
            organizationId,
            businessId: business.businessId,
            profileId: profile.id,
            profileVersion: profile.activeVersion,
            featureSetVersion: FEATURE_SET_VERSION,
            factsHash: vectorHash(result.features),
            computedAt,
          } satisfies ScoreWrite,
        };
      }),
    );
    const outcome = await this.commit(
      organizationId,
      facts.map((f) => f.businessId),
      scored,
      options.force ?? false,
    );
    // After the commit (`compute` is never called inside an outer transaction): pages showing these businesses
    // refetch their scores (best effort, like all realtime).
    if (options.notify !== false && outcome.businesses.size > 0) {
      if (outcome.businesses.size > NOTIFY_EACH_UP_TO) {
        await this.realtime.publish(organizationId, {
          type: SCORING_SCORES_UPDATED,
          entity: 'workspace',
          entityId: organizationId,
        });
      } else {
        for (const businessId of outcome.businesses) {
          await this.realtime.publish(organizationId, {
            type: SCORING_SCORES_UPDATED,
            entity: 'business',
            entityId: businessId,
          });
        }
      }
    }
    return { scored: scored.length, written: outcome.written, unchanged: outcome.unchanged };
  }

  /**
   * Writes the scores that changed, in one transaction under per-business locks (concurrent jobs for a business
   * write one after the other; facts older than the stored score never overwrite it). History is appended only for
   * a new fingerprint (profile version, feature-set version, vector): a forced recompute of unchanged facts rewrites
   * the current row (listing columns) without duplicating history.
   */
  @Transactional()
  private async commit(
    organizationId: string,
    businessIds: readonly string[],
    scored: readonly { readonly profile: ActiveProfile; readonly write: ScoreWrite }[],
    force: boolean,
  ): Promise<{
    readonly written: number;
    readonly unchanged: number;
    readonly businesses: ReadonlySet<string>;
  }> {
    if (scored.length === 0) return { written: 0, unchanged: 0, businesses: new Set() };
    const locked = await this.repository.lockBusinesses(organizationId, businessIds);
    // Read under the locks: a primary switch or an activation committed meanwhile is what this batch sees.
    const primary = await this.primaryProfileId(organizationId);
    const active = await this.repository.activeVersions([
      ...new Set(scored.map(({ profile }) => profile.id)),
    ]);
    const current = await this.repository.currentScores(organizationId, businessIds);
    const writes: ScoreWriteRequest[] = [];
    const previous = new Map<string, { score: number; tier: ScoreWrite['tier'] }>();
    let unchanged = 0;
    for (const { profile, write } of scored) {
      const stored = current.get(write.businessId)?.find((score) => score.profileId === profile.id);
      const same =
        stored?.profileVersion === write.profileVersion &&
        stored.featureSetVersion === write.featureSetVersion &&
        stored.factsHash === write.factsHash;
      // A write of a version that is no longer active comes from a job that started before an activation: drop it.
      // Against the stored row, the active version wins (whatever its number: a rollback is allowed); same version,
      // a newer feature set wins; same feature set, the later computation wins.
      // DECISION(BF-031): an unchanged write keeps its computed_at, so facts going A → B → A may let a slow job
      // holding B land after the second A; the next change of facts corrects it.
      if (!locked.has(write.businessId) || active.get(profile.id) !== write.profileVersion) {
        unchanged += 1;
        continue;
      }
      const newer =
        stored !== undefined &&
        stored.profileVersion === write.profileVersion &&
        (stored.featureSetVersion > write.featureSetVersion ||
          (stored.featureSetVersion === write.featureSetVersion &&
            stored.computedAt.getTime() > write.computedAt.getTime()));
      if (newer || (same && !force)) {
        unchanged += 1;
        continue;
      }
      if (stored)
        previous.set(`${write.businessId}:${write.profileId}`, { score: stored.score, tier: stored.tier });
      writes.push({ ...write, history: !same });
    }
    if (writes.length > 0) await this.repository.writeScores(writes, primary);
    const offerOf = new Map(scored.map(({ profile }) => [profile.id, profile.offer]));
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
          offer: profileOffer(offerOf, write.profileId),
          score: write.score,
          tier: write.tier,
          previousScore: before.score,
          previousTier: before.tier,
          primary: true,
        },
      });
    }
    return {
      written: writes.length,
      unchanged,
      businesses: new Set(writes.map((write) => write.businessId)),
    };
  }
}
