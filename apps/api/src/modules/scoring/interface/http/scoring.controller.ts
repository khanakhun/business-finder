import {
  type BusinessScoreList,
  BusinessScoreListSchema,
  ScoringExplainRequestSchema,
  type ScoringExplainResponse,
  ScoringExplainResponseSchema,
  type ScoringProfileList,
  ScoringProfileListSchema,
  type ScoringProfileVersion,
  ScoringProfileVersionSchema,
  type ScoringRecomputeResponse,
  ScoringRecomputeResponseSchema,
  SetPrimaryScoringProfileRequestSchema,
} from '@bf/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import {
  RecomputeProfileCommand,
  ScoringQueries,
  SetPrimaryProfileCommand,
} from '../../application/scoring.use-cases.ts';

class ExplainBody extends zodDto(ScoringExplainRequestSchema) {}
class PrimaryBody extends zodDto(SetPrimaryScoringProfileRequestSchema) {}

/** Routes guarantee an active workspace (`@RequirePermission`); reaching here without one is a wiring bug. */
function workspaceOf(auth: AuthContext): string {
  if (!auth.orgId) throw new Error('Scoring route reached without an active workspace');
  return auth.orgId;
}

/** A business's scores (BF-031). Another workspace's business is a 404. */
@ApiTags('scoring')
@Controller('businesses')
export class BusinessScoresController {
  constructor(private readonly queries: ScoringQueries) {}

  @Get(':id/scores')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: "The business's current score per profile of the workspace, with contributions and reasons",
    operationId: 'getBusinessScores',
    response: { status: 200, schema: BusinessScoreListSchema },
    errors: [401, 403, 404],
  })
  scores(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) businessId: string,
  ): Promise<BusinessScoreList> {
    return this.queries.businessScores(workspaceOf(auth), businessId);
  }
}

/** Scoring profiles (BF-031): built-ins and the workspace's own, versions, recompute, primary choice, explain. */
@ApiTags('scoring')
@Controller('scoring')
export class ScoringController {
  constructor(
    private readonly queries: ScoringQueries,
    private readonly recompute: RecomputeProfileCommand,
    private readonly primary: SetPrimaryProfileCommand,
  ) {}

  @Get('profiles')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'The scoring profiles the workspace sees (built-in and its own), and which one is primary',
    operationId: 'listScoringProfiles',
    response: { status: 200, schema: ScoringProfileListSchema },
    errors: [401, 403],
  })
  profiles(@Ctx() auth: AuthContext): Promise<ScoringProfileList> {
    return this.queries.profiles(workspaceOf(auth));
  }

  @Get('profiles/:id/versions/:version')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'One version of a scoring profile (its config)',
    operationId: 'getScoringProfileVersion',
    response: { status: 200, schema: ScoringProfileVersionSchema },
    errors: [400, 401, 403, 404],
  })
  version(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) profileId: string,
    @Param('version', ParseIntPipe) version: number,
  ): Promise<ScoringProfileVersion> {
    return this.queries.version(workspaceOf(auth), profileId, version);
  }

  @Post('profiles/:id/recompute')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary:
      "Recompute every tracked business's score with the profile's active version (progress in realtime)",
    operationId: 'recomputeScoringProfile',
    response: { status: 202, schema: ScoringRecomputeResponseSchema },
    errors: [401, 403, 404, 429],
  })
  recomputeProfile(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) profileId: string,
  ): Promise<ScoringRecomputeResponse> {
    return this.recompute.execute(workspaceOf(auth), profileId, auth.userId);
  }

  @Put('primary-profile')
  @HttpCode(202)
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: "Choose the workspace's primary profile: the listing's score and tier follow it (recomputed)",
    operationId: 'setPrimaryScoringProfile',
    body: PrimaryBody,
    response: { status: 202, schema: ScoringRecomputeResponseSchema },
    errors: [400, 401, 403, 404, 422],
  })
  setPrimary(@Ctx() auth: AuthContext, @Body() body: PrimaryBody): Promise<ScoringRecomputeResponse> {
    return this.primary.execute(workspaceOf(auth), body.profileId, auth.userId);
  }

  @Post('explain')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'Score a tracked business with a draft profile config, nothing stored (profile editor preview)',
    operationId: 'explainScore',
    body: ExplainBody,
    response: { status: 200, schema: ScoringExplainResponseSchema },
    errors: [400, 401, 403, 404, 422, 429],
  })
  explain(@Ctx() auth: AuthContext, @Body() body: ExplainBody): Promise<ScoringExplainResponse> {
    return this.queries.explain(workspaceOf(auth), body);
  }
}
