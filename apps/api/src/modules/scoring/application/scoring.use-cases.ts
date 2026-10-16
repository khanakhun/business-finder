import {
  type BusinessScore,
  type BusinessScoreList,
  type Clock,
  FEATURE_SET_VERSION,
  NotFoundError,
  type ScoringExplainRequest,
  type ScoringExplainResponse,
  type ScoringProfileList,
  type ScoringProfileVersion,
  type ScoringRecomputeResponse,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { scoreBusiness } from '../domain/engine.ts';
import {
  FACTS_ASSEMBLER,
  type FactsAssembler,
  RECOMPUTE_PROGRESS,
  type RecomputeProgress,
  SCORING_QUEUE,
  SCORING_REPOSITORY,
  type ScoringQueue,
  type ScoringRepository,
  type StoredScore,
} from './ports.ts';
import { SCORING_BATCH, ScoringService } from './scoring.service.ts';

const toBusinessScore = (score: StoredScore, offer: BusinessScore['offer']): BusinessScore => ({
  businessId: score.businessId,
  profileId: score.profileId,
  profileVersion: score.profileVersion,
  featureSetVersion: score.featureSetVersion,
  offer,
  score: score.score,
  tier: score.tier,
  contributions: score.contributions,
  reasons: score.reasons,
  gated: score.gated,
  features: score.features,
  computedAt: score.computedAt.toISOString(),
});

/** Reads of the scoring module (BF-031): a business's scores, the profiles, a version, a draft's explanation. */
@Injectable()
export class ScoringQueries {
  constructor(
    @Inject(SCORING_REPOSITORY) private readonly repository: ScoringRepository,
    @Inject(FACTS_ASSEMBLER) private readonly assembler: FactsAssembler,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly scoring: ScoringService,
  ) {}

  async businessScores(organizationId: string, businessId: string): Promise<BusinessScoreList> {
    await this.assertTracked(organizationId, businessId);
    const offers = new Map((await this.repository.profiles(organizationId)).map((p) => [p.id, p.offer]));
    const scores = await this.repository.businessScores(organizationId, businessId);
    return {
      items: scores.flatMap((score) => {
        const offer = offers.get(score.profileId);
        return offer ? [toBusinessScore(score, offer)] : [];
      }),
    };
  }

  async profiles(organizationId: string): Promise<ScoringProfileList> {
    const primary = await this.scoring.primaryProfileId(organizationId);
    return {
      items: (await this.repository.profiles(organizationId)).map((profile) => ({
        id: profile.id,
        offer: profile.offer,
        name: profile.name,
        builtin: profile.builtin,
        activeVersion: profile.activeVersion,
        primary: profile.id === primary,
        archived: profile.archived,
      })),
    };
  }

  async version(organizationId: string, profileId: string, version: number): Promise<ScoringProfileVersion> {
    if (!(await this.repository.profile(organizationId, profileId)))
      throw new NotFoundError('ScoringProfile', profileId);
    const found = await this.repository.version(profileId, version);
    if (!found) throw new NotFoundError('ScoringProfileVersion', `${profileId}@${version}`);
    return {
      profileId,
      version: found.version,
      config: found.config,
      createdAt: found.createdAt.toISOString(),
    };
  }

  /** Scores a tracked business with a draft config, nothing stored (BF-032 preview). */
  async explain(organizationId: string, request: ScoringExplainRequest): Promise<ScoringExplainResponse> {
    await this.assertTracked(organizationId, request.businessId);
    const [facts] = await this.assembler.assemble(organizationId, [request.businessId], this.clock.now());
    if (!facts) throw new NotFoundError('Business', request.businessId);
    return { ...scoreBusiness(request.config, facts), featureSetVersion: FEATURE_SET_VERSION };
  }

  private async assertTracked(organizationId: string, businessId: string): Promise<void> {
    if (!(await this.repository.tracks(organizationId, businessId)))
      throw new NotFoundError('Business', businessId);
  }
}

/** Starts a bulk recompute of a profile's active version for the workspace (progress in realtime). */
@Injectable()
export class RecomputeProfileCommand {
  constructor(
    @Inject(SCORING_REPOSITORY) private readonly repository: ScoringRepository,
    @Inject(SCORING_QUEUE) private readonly queue: ScoringQueue,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    organizationId: string,
    profileId: string,
    userId: string | null,
  ): Promise<ScoringRecomputeResponse> {
    const profile = await this.repository.profile(organizationId, profileId);
    if (!profile?.activeVersion) throw new NotFoundError('ScoringProfile', profileId);
    const total = await this.repository.trackedCount(organizationId);
    await this.queue.recompute({
      organizationId,
      profileId,
      version: profile.activeVersion,
      // Unique per request (the job id); the queue merges requests per workspace and profile (deduplication).
      idempotencyKey: `recompute:${organizationId}:${profileId}:${profile.activeVersion}:${this.clock.now().getTime()}`,
      ...(userId ? { requestedBy: userId } : {}),
    });
    return { profileId, version: profile.activeVersion, total };
  }
}

/** Runs a bulk recompute: every tracked business of the workspace, page by page, with throttled progress. */
@Injectable()
export class RecomputeRunner {
  constructor(
    @Inject(SCORING_REPOSITORY) private readonly repository: ScoringRepository,
    @Inject(RECOMPUTE_PROGRESS) private readonly progress: RecomputeProgress,
    private readonly scoring: ScoringService,
  ) {}

  async run(
    organizationId: string,
    profileId: string,
    requested: number,
    signal?: AbortSignal,
  ): Promise<{ readonly done: number; readonly written: number }> {
    // Scores use the version active now (a merged request may name an older one): progress says which.
    const version = (await this.repository.profile(organizationId, profileId))?.activeVersion ?? requested;
    const total = await this.repository.trackedCount(organizationId);
    let after: string | null = null;
    let done = 0;
    let written = 0;
    for (;;) {
      signal?.throwIfAborted();
      const page = await this.repository.trackedPage(organizationId, after, SCORING_BATCH);
      if (page.length === 0) break;
      const outcome = await this.scoring.compute(organizationId, page, {
        profileIds: [profileId],
        force: true,
        notify: false,
      });
      done += page.length;
      written += outcome.written;
      after = page.at(-1) ?? null;
      await this.progress.progressed(organizationId, {
        profileId,
        version,
        done,
        total: Math.max(total, done),
      });
    }
    await this.progress.finished(organizationId, { profileId, version, done, total: Math.max(total, done) });
    return { done, written };
  }
}

/** Makes a profile the workspace's primary one: the listing's score and tier follow it. */
@Injectable()
export class SetPrimaryProfileCommand {
  constructor(
    @Inject(SCORING_REPOSITORY) private readonly repository: ScoringRepository,
    private readonly recompute: RecomputeProfileCommand,
  ) {}

  async execute(
    organizationId: string,
    profileId: string,
    userId: string | null,
  ): Promise<ScoringRecomputeResponse> {
    await this.switch(organizationId, profileId, userId);
    // Enqueued after the commit: the recompute must see the new primary profile.
    return this.recompute.execute(organizationId, profileId, userId);
  }

  @Transactional()
  private async switch(organizationId: string, profileId: string, userId: string | null): Promise<void> {
    const profile = await this.repository.profile(organizationId, profileId);
    if (!profile?.activeVersion) throw new NotFoundError('ScoringProfile', profileId);
    await this.repository.setPrimaryProfile(organizationId, profileId, userId);
    // The scores already there fill the listing now; the recompute fills in the rest.
    await this.repository.denormalizePrimary(organizationId, profileId);
  }
}
