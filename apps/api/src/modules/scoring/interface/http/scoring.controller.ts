import {
  ActivateScoringProfileVersionRequestSchema,
  type BusinessScoreList,
  BusinessScoreListSchema,
  CreateScoringProfileRequestSchema,
  CreateScoringProfileVersionRequestSchema,
  NotFoundError,
  ScoringExplainBatchRequestSchema,
  type ScoringExplainBatchResponse,
  ScoringExplainBatchResponseSchema,
  ScoringExplainRequestSchema,
  type ScoringExplainResponse,
  ScoringExplainResponseSchema,
  type ScoringPreviewSample,
  ScoringPreviewSampleQuerySchema,
  ScoringPreviewSampleSchema,
  type ScoringProfileList,
  ScoringProfileListSchema,
  type ScoringProfileSummary,
  ScoringProfileSummarySchema,
  type ScoringProfileVersion,
  type ScoringProfileVersionList,
  ScoringProfileVersionListSchema,
  ScoringProfileVersionSchema,
  type ScoringRecomputeResponse,
  ScoringRecomputeResponseSchema,
  type ScoringVersionCreated,
  ScoringVersionCreatedSchema,
  SetPrimaryScoringProfileRequestSchema,
  UpdateScoringProfileRequestSchema,
} from '@bf/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import {
  ScoringEditorQueries,
  ScoringProfileCommands,
} from '../../application/profile-management.use-cases.ts';
import {
  RecomputeBusinessCommand,
  RecomputeProfileCommand,
  ScoringQueries,
  SetPrimaryProfileCommand,
} from '../../application/scoring.use-cases.ts';

const MAX_VERSION = 2_147_483_647;

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
  constructor(
    private readonly queries: ScoringQueries,
    private readonly recomputeBusiness: RecomputeBusinessCommand,
  ) {}

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

  @Post(':id/scores/recompute')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Recompute the business’s scores now (every active profile) and return them',
    operationId: 'recomputeBusinessScores',
    response: { status: 200, schema: BusinessScoreListSchema },
    errors: [401, 403, 404, 429],
  })
  recompute(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) businessId: string,
  ): Promise<BusinessScoreList> {
    return this.recomputeBusiness.execute(workspaceOf(auth), businessId);
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
    // Versions are positive int4: anything else names no version (and must not reach the database).
    if (version < 1 || version > MAX_VERSION)
      throw new NotFoundError('ScoringProfileVersion', `${profileId}@${version}`);
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
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
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

class CreateProfileBody extends zodDto(CreateScoringProfileRequestSchema) {}
class UpdateProfileBody extends zodDto(UpdateScoringProfileRequestSchema) {}
class CreateVersionBody extends zodDto(CreateScoringProfileVersionRequestSchema) {}
class ActivateBody extends zodDto(ActivateScoringProfileVersionRequestSchema) {}
class ExplainBatchBody extends zodDto(ScoringExplainBatchRequestSchema) {}
class SampleQuery extends zodDto(ScoringPreviewSampleQuerySchema) {}

/** The workspace's own profiles and the profile editor (BF-032). Built-in profiles are read-only (409). */
@ApiTags('scoring')
@Controller('scoring')
export class ScoringProfilesController {
  constructor(
    private readonly commands: ScoringProfileCommands,
    private readonly editor: ScoringEditorQueries,
  ) {}

  @Post('profiles')
  // Each new profile is scored for every tracked business of the workspace.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary:
      'Create a workspace profile from a profile it sees (its active config becomes version 1, active)',
    operationId: 'createScoringProfile',
    body: CreateProfileBody,
    response: { status: 201, schema: ScoringProfileSummarySchema },
    errors: [400, 401, 403, 404, 409, 422, 429],
  })
  create(@Ctx() auth: AuthContext, @Body() body: CreateProfileBody): Promise<ScoringProfileSummary> {
    return this.commands.create(workspaceOf(auth), body, auth.userId);
  }

  @Patch('profiles/:id')
  // Unarchiving recomputes the workspace.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'Rename or (un)archive a workspace profile (an archived profile is no longer scored)',
    operationId: 'updateScoringProfile',
    body: UpdateProfileBody,
    response: { status: 200, schema: ScoringProfileSummarySchema },
    errors: [400, 401, 403, 404, 409, 422, 429],
  })
  update(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) profileId: string,
    @Body() body: UpdateProfileBody,
  ): Promise<ScoringProfileSummary> {
    return this.commands.update(workspaceOf(auth), profileId, body);
  }

  @Get('profiles/:id/versions')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: "A profile's versions, newest first",
    operationId: 'listScoringProfileVersions',
    response: { status: 200, schema: ScoringProfileVersionListSchema },
    errors: [401, 403, 404],
  })
  versions(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) profileId: string,
  ): Promise<ScoringProfileVersionList> {
    return this.editor.versions(workspaceOf(auth), profileId);
  }

  @Post('profiles/:id/versions')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'Save a draft as a new (inactive, immutable) version of a workspace profile',
    operationId: 'createScoringProfileVersion',
    body: CreateVersionBody,
    response: { status: 201, schema: ScoringVersionCreatedSchema },
    errors: [400, 401, 403, 404, 409, 422, 429],
  })
  addVersion(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) profileId: string,
    @Body() body: CreateVersionBody,
  ): Promise<ScoringVersionCreated> {
    return this.commands.addVersion(workspaceOf(auth), profileId, body, auth.userId);
  }

  @Post('profiles/:id/activate')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'Activate a saved version: the workspace recomputes with it (progress in realtime)',
    operationId: 'activateScoringProfileVersion',
    body: ActivateBody,
    response: { status: 202, schema: ScoringProfileSummarySchema },
    errors: [400, 401, 403, 404, 409, 422, 429],
  })
  activate(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) profileId: string,
    @Body() body: ActivateBody,
  ): Promise<ScoringProfileSummary> {
    return this.commands.activate(workspaceOf(auth), profileId, body);
  }

  @Get('preview-sample')
  // Ranks every tracked business of the workspace.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: "A sample of the workspace's businesses (≤ 200), stratified by their tier for a profile",
    operationId: 'getScoringPreviewSample',
    query: SampleQuery,
    response: { status: 200, schema: ScoringPreviewSampleSchema },
    errors: [400, 401, 403, 404, 429],
  })
  sample(@Ctx() auth: AuthContext, @Query() query: SampleQuery): Promise<ScoringPreviewSample> {
    return this.editor.sample(workspaceOf(auth), query);
  }

  @Post('explain/batch')
  @HttpCode(200)
  // A preview of 200 businesses is 4 calls: 15 previews a minute (the editor debounces).
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'Score up to 50 tracked businesses with a draft config, nothing stored (live preview)',
    operationId: 'explainScoreBatch',
    body: ExplainBatchBody,
    response: { status: 200, schema: ScoringExplainBatchResponseSchema },
    errors: [400, 401, 403, 422, 429],
  })
  explainBatch(
    @Ctx() auth: AuthContext,
    @Body() body: ExplainBatchBody,
  ): Promise<ScoringExplainBatchResponse> {
    return this.editor.explainBatch(workspaceOf(auth), body);
  }
}
