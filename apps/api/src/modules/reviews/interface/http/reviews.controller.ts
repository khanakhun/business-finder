import {
  AcknowledgeGoogleReviewsRequestSchema,
  AnalyzePastedReviewsRequestSchema,
  type BusinessReviewInsights,
  BusinessReviewInsightsSchema,
  type ReviewSourcesStatus,
  ReviewSourcesStatusSchema,
  UpdateReviewSourcesRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { ReviewGates } from '../../application/review-gates.ts';
import {
  AnalyzePastedReviewsCommand,
  ReviewInsightsQuery,
} from '../../application/review-insights.use-cases.ts';

class AnalyzeBody extends zodDto(AnalyzePastedReviewsRequestSchema) {}
class UpdateSourcesBody extends zodDto(UpdateReviewSourcesRequestSchema) {}
class AcknowledgeBody extends zodDto(AcknowledgeGoogleReviewsRequestSchema) {}

/** Review insights of a business and manual analysis of pasted reviews (BF-029). */
@ApiTags('reviews')
@Controller('businesses')
export class BusinessReviewsController {
  constructor(
    private readonly query: ReviewInsightsQuery,
    private readonly analyzePasted: AnalyzePastedReviewsCommand,
  ) {}

  @Get(':id/review-insights')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: "The workspace's aggregated review insights for the business, and the review sources it may use",
    operationId: 'getBusinessReviewInsights',
    response: { status: 200, schema: BusinessReviewInsightsSchema },
    errors: [401, 403, 404],
  })
  insights(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) businessId: string,
  ): Promise<BusinessReviewInsights> {
    return this.query.execute(auth, businessId);
  }

  @Post(':id/reviews/analyze')
  @HttpCode(200)
  @RequirePermission('business:write')
  // Each paste is up to three model calls.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiRoute({
    summary:
      'Analyse pasted reviews (anonymized, classified, then discarded: only aggregated insights are kept)',
    operationId: 'analyzePastedReviews',
    body: AnalyzeBody,
    response: { status: 200, schema: BusinessReviewInsightsSchema },
    errors: [400, 401, 402, 403, 404, 409, 422, 429],
  })
  analyze(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) businessId: string,
    @Body() body: AnalyzeBody,
  ): Promise<BusinessReviewInsights> {
    return this.analyzePasted.execute(auth, businessId, body);
  }
}

/** Review sources and their licensing gates (BF-029). */
@ApiTags('reviews')
@Controller('reviews')
export class ReviewSourcesController {
  constructor(private readonly gates: ReviewGates) {}

  @Get('sources')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Review sources: what each licence allows, what the workspace chose, what applies now',
    operationId: 'getReviewSources',
    response: { status: 200, schema: ReviewSourcesStatusSchema },
    errors: [401, 403],
  })
  status(@Ctx() auth: AuthContext): Promise<ReviewSourcesStatus> {
    return this.gates.status(auth);
  }

  @Put('sources')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary:
      'Choose whether scraped reviews feed insights (turning it off forgets what was derived from them)',
    operationId: 'updateReviewSources',
    body: UpdateSourcesBody,
    response: { status: 200, schema: ReviewSourcesStatusSchema },
    errors: [400, 401, 403, 422],
  })
  update(@Ctx() auth: AuthContext, @Body() body: UpdateSourcesBody): Promise<ReviewSourcesStatus> {
    return this.gates.update(auth, body);
  }

  @Post('sources/google/acknowledgement')
  @HttpCode(200)
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary:
      'Acknowledge the Google terms warning and derive insights from Google reviews (workspace owner only; audited)',
    operationId: 'acknowledgeGoogleReviewsTerms',
    body: AcknowledgeBody,
    response: { status: 200, schema: ReviewSourcesStatusSchema },
    errors: [400, 401, 403, 422],
  })
  acknowledge(@Ctx() auth: AuthContext, @Body() body: AcknowledgeBody): Promise<ReviewSourcesStatus> {
    return this.gates.acknowledgeGoogle(auth, body.termsVersion);
  }

  @Delete('sources/google/acknowledgement')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Stop using Google reviews and forget the insights derived from them (workspace owner only)',
    operationId: 'revokeGoogleReviewsTerms',
    response: { status: 200, schema: ReviewSourcesStatusSchema },
    errors: [401, 403],
  })
  revoke(@Ctx() auth: AuthContext): Promise<ReviewSourcesStatus> {
    return this.gates.revokeGoogle(auth);
  }
}
