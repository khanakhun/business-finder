import type { Clock } from '@bf/contracts';
import {
  type AnalyzePastedReviewsRequest,
  type BusinessReviewInsights,
  ConflictError,
  NotFoundError,
  type ReviewInsights,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import type { CombinedInsights } from '../domain/insights.ts';
import {
  REVIEW_INSIGHTS,
  REVIEW_SUBJECTS,
  type ReviewInsightsRepository,
  type ReviewSubjectReader,
} from './ports.ts';
import { ReviewGates, workspaceOf } from './review-gates.ts';
import { ReviewMiningService } from './review-mining.service.ts';

export function toReviewInsights(businessId: string, combined: CombinedInsights): ReviewInsights {
  return { businessId, ...combined };
}

/** `GET /v1/businesses/:id/review-insights`: the workspace's insights and what it may analyse. */
@Injectable()
export class ReviewInsightsQuery {
  constructor(
    @Inject(REVIEW_INSIGHTS) private readonly insights: ReviewInsightsRepository,
    @Inject(REVIEW_SUBJECTS) private readonly subjects: ReviewSubjectReader,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly gates: ReviewGates,
    private readonly mining: ReviewMiningService,
  ) {}

  async execute(auth: AuthContext, businessId: string): Promise<BusinessReviewInsights> {
    const organizationId = workspaceOf(auth);
    if (!(await this.subjects.tracks(organizationId, businessId)))
      throw new NotFoundError('Business', businessId);
    const row = await this.insights.find(organizationId, businessId);
    const now = this.clock.now();
    // A contribution expired since the last write is left out at once (the nightly purge deletes it later); the
    // other sources' part stays visible.
    const expired = row?.combined.expiresAt && Date.parse(row.combined.expiresAt) <= now.getTime();
    const combined = !row
      ? null
      : expired
        ? await this.mining.combinedAt(businessId, row.contributions, now)
        : row.combined;
    return {
      insights: combined ? toReviewInsights(businessId, combined) : null,
      sources: await this.gates.gatesFor(organizationId),
    };
  }
}

/**
 * `POST /v1/businesses/:id/reviews/analyze`: reviews a member pasted, analysed on the fly. The text is anonymized,
 * classified and discarded (`transient_insights`); only the aggregated contribution is kept.
 */
@Injectable()
export class AnalyzePastedReviewsCommand {
  constructor(
    @Inject(REVIEW_SUBJECTS) private readonly subjects: ReviewSubjectReader,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly gates: ReviewGates,
    private readonly mining: ReviewMiningService,
  ) {}

  async execute(
    auth: AuthContext,
    businessId: string,
    body: AnalyzePastedReviewsRequest,
  ): Promise<BusinessReviewInsights> {
    const organizationId = workspaceOf(auth);
    if (!(await this.subjects.tracks(organizationId, businessId)))
      throw new NotFoundError('Business', businessId);
    const subject = await this.subjects.find(businessId);
    if (!subject) throw new NotFoundError('Business', businessId);
    if (!(await this.gates.isAllowed(organizationId, 'manual'))) {
      throw new ConflictError('Pasted reviews are turned off for this workspace.', {
        details: { reason: 'LICENSING_DISABLED' },
      });
    }
    const outcome = await this.mining.analyze(
      organizationId,
      subject,
      {
        source: 'manual',
        reviews: body.reviews.map((review) => ({
          text: review.text,
          ...(review.rating !== undefined ? { rating: review.rating } : {}),
          ownerResponded: null,
          knownNames: [],
        })),
        rating: null,
        fetchedAt: this.clock.now(),
        costUsd: 0,
      },
      { allowed: () => this.gates.isAllowed(organizationId, 'manual') },
    );
    if (outcome.dropped) {
      throw new ConflictError('Pasted reviews are turned off for this workspace.', {
        details: { reason: 'LICENSING_DISABLED' },
      });
    }
    if (outcome.analysed === 0) {
      throw new ConflictError('None of the pasted reviews could be analysed.', {
        details: { reason: 'NOTHING_ANALYSED' },
      });
    }
    return {
      insights: outcome.insights ? toReviewInsights(businessId, outcome.insights) : null,
      sources: await this.gates.gatesFor(organizationId),
    };
  }
}
