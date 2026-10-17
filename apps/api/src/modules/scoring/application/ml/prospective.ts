import { type Clock, ConflictError, NotFoundError, type ProspectiveComparison } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { CURRENT_LABEL_VERSION, LABEL_DEFINITIONS, labelOf } from '../../domain/ml/label-definition.ts';
import { checkPromotion, DEFAULT_PROMOTION_CRITERIA } from '../../domain/ml/promotion-policy.ts';
import { spearman, topShare } from '../../domain/ml/stats.ts';
import { SCORING_REPOSITORY, type ScoringRepository } from '../ports.ts';
import {
  ML_REPOSITORY,
  type MlRepository,
  MODEL_LIFECYCLE,
  type ModelLifecycleRepository,
  SHADOW_REPOSITORY,
  type ShadowRepository,
} from './ports.ts';

// The prospective comparison (BF-059): contacts made since the shadow started, whose outcome is now known, ranked
// by what the active profile said at the contact and by what the shadow model said then. Conversion of each top
// 20%, the lift, the rank correlation and how tiers moved — the evidence a promotion is judged on.

const TOP = 0.2;

@Injectable()
export class ProspectiveComparisonService {
  constructor(
    @Inject(SHADOW_REPOSITORY) private readonly shadows: ShadowRepository,
    @Inject(ML_REPOSITORY) private readonly contacts: MlRepository,
    @Inject(MODEL_LIFECYCLE) private readonly lifecycle: ModelLifecycleRepository,
    @Inject(SCORING_REPOSITORY) private readonly profiles: ScoringRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async compare(organizationId: string, profileId: string): Promise<ProspectiveComparison> {
    const assignment = (await this.shadows.assignments(organizationId)).get(profileId);
    if (!assignment) throw new ConflictError('No model runs in shadow for this profile.');
    const profile = await this.profiles.profile(organizationId, profileId);
    if (!profile) throw new NotFoundError('ScoringProfile', profileId);
    const definition = LABEL_DEFINITIONS[CURRENT_LABEL_VERSION];
    if (!definition) throw new Error('No label definition');
    const now = this.clock.now();
    const rows = await this.contacts.contacts(
      organizationId,
      profile.offer,
      assignment.startedAt,
      now,
      definition.horizonDays,
    );
    const labelled = rows
      .map((row) => ({
        row,
        label: labelOf({ firstContactAt: row.t0, bounced: row.bounced, events: row.events }, definition, now),
      }))
      .filter((item) => item.label === 'positive' || item.label === 'negative');
    const scores = await this.lifecycle.scoresAt(
      organizationId,
      profileId,
      assignment.modelId,
      labelled.map(({ row }) => ({ businessId: row.businessId, t0: row.t0 })),
    );
    const paired = labelled.flatMap((item, i) => {
      const score = scores[i];
      return score && score.activeScore !== null && score.shadowProbability !== null
        ? [{ positive: item.label === 'positive', score }]
        : [];
    });
    const active = paired.map(({ score }) => score.activeScore ?? 0);
    const shadow = paired.map(({ score }) => score.shadowProbability ?? 0);
    const top = (ranking: number[]) => {
      if (ranking.length === 0) return { n: 0, positives: 0, rate: null };
      const picked = topShare(ranking, TOP);
      const positives = picked.filter((i) => paired[i]?.positive).length;
      return { n: picked.length, positives, rate: positives / picked.length };
    };
    const activeTop = top(active);
    const shadowTop = top(shadow);
    const positives = labelled.filter((item) => item.label === 'positive').length;
    const check = checkPromotion({ positives, active: activeTop, shadow: shadowTop });
    const tierMatrix: Record<string, Record<string, number>> = {};
    for (const { score } of paired) {
      const from = score.activeTier ?? '?';
      const to = score.shadowTier ?? '?';
      tierMatrix[from] = { ...tierMatrix[from], [to]: (tierMatrix[from]?.[to] ?? 0) + 1 };
    }
    return {
      profileId,
      modelId: assignment.modelId,
      since: assignment.startedAt.toISOString(),
      contacts: labelled.length,
      positives,
      active: activeTop,
      shadow: shadowTop,
      lift: check.lift,
      spearman: spearman(active, shadow),
      tierMatrix,
      criteria: {
        minPositives: DEFAULT_PROMOTION_CRITERIA.minPositives,
        minLift: DEFAULT_PROMOTION_CRITERIA.minLift,
        interval: 0.9,
      },
      enoughPositives: check.enoughPositives,
      liftMet: check.liftMet,
      intervalsSeparate: check.intervalsSeparate,
      eligible: check.eligible,
    };
  }
}
