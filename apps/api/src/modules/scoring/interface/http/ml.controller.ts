import {
  BuildMlDatasetRequestSchema,
  MlDatasetSchema,
  MlModelSchema,
  MlReadinessQuerySchema,
  MlReadinessSchema,
  MlTrainingRunSchema,
  ModelMonitoringSchema,
  ModelPromotionSchema,
  PromoteModelRequestSchema,
  ProspectiveComparisonSchema,
  RollbackModelRequestSchema,
  SetShadowModelRequestSchema,
  ShadowAssignmentSchema,
  ShadowScoreSchema,
  StartMlTrainingRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { DatasetBuilder, type MlActor } from '../../application/ml/dataset-builder.ts';
import { ModelTrainer } from '../../application/ml/model-trainer.ts';
import { ModelMonitor } from '../../application/ml/monitor.ts';
import { PromotionService } from '../../application/ml/promotion.service.ts';
import { ProspectiveComparisonService } from '../../application/ml/prospective.ts';
import { ShadowService } from '../../application/ml/shadow.service.ts';

class ReadinessQuery extends zodDto(MlReadinessQuerySchema) {}
class BuildBody extends zodDto(BuildMlDatasetRequestSchema) {}
class TrainBody extends zodDto(StartMlTrainingRequestSchema) {}
class ShadowBody extends zodDto(SetShadowModelRequestSchema) {}
class PromoteBody extends zodDto(PromoteModelRequestSchema) {}
class RollbackBody extends zodDto(RollbackModelRequestSchema) {}

const MlDatasetListSchema = z.object({ items: z.array(MlDatasetSchema) }).meta({ id: 'MlDatasetList' });
const MlTrainingRunListSchema = z
  .object({ items: z.array(MlTrainingRunSchema) })
  .meta({ id: 'MlTrainingRunList' });
const MlModelListSchema = z.object({ items: z.array(MlModelSchema) }).meta({ id: 'MlModelList' });
const ShadowAssignmentListSchema = z
  .object({ items: z.array(ShadowAssignmentSchema) })
  .meta({ id: 'ShadowAssignmentList' });
const ModelPromotionListSchema = z
  .object({ items: z.array(ModelPromotionSchema) })
  .meta({ id: 'ModelPromotionList' });
const ModelMonitoringResultSchema = z
  .object({ latest: ModelMonitoringSchema.nullable() })
  .meta({ id: 'ModelMonitoringResult' });
const ShadowScoreListSchema = z.object({ items: z.array(ShadowScoreSchema) }).meta({ id: 'ShadowScoreList' });

function actorOf(auth: AuthContext): MlActor {
  if (!auth.orgId) throw new Error('Scoring route reached without an active workspace');
  return { organizationId: auth.orgId, userId: auth.userId };
}

/**
 * Outcome-trained scoring (BF-059): whether the workspace has enough outcomes to learn from, and the labelled,
 * leakage-checked datasets built from its first contacts.
 */
@ApiTags('scoring')
@Controller('scoring/ml')
export class ScoringMlController {
  constructor(
    private readonly datasets: DatasetBuilder,
    private readonly trainer: ModelTrainer,
    private readonly shadows: ShadowService,
    private readonly comparison: ProspectiveComparisonService,
    private readonly promotions: PromotionService,
    private readonly monitor: ModelMonitor,
  ) {}

  @Get('readiness')
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'Labelled contacts and positives so far, against the minimum to train a model',
    operationId: 'getScoringMlReadiness',
    query: ReadinessQuery,
    response: { status: 200, schema: MlReadinessSchema },
    errors: [400, 401, 403],
  })
  readiness(@Ctx() auth: AuthContext, @Query() query: ReadinessQuery) {
    return this.datasets.readiness(actorOf(auth).organizationId, query.offer);
  }

  @Get('datasets')
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'The labelled datasets built so far (manifests)',
    operationId: 'listScoringMlDatasets',
    response: { status: 200, schema: MlDatasetListSchema },
    errors: [401, 403],
  })
  async list(@Ctx() auth: AuthContext) {
    return { items: await this.datasets.list(actorOf(auth).organizationId) };
  }

  @Post('datasets')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'Build a labelled dataset of first contacts (422 below 300 contacts or 30 positives)',
    operationId: 'buildScoringMlDataset',
    body: BuildBody,
    response: { status: 201, schema: MlDatasetSchema },
    errors: [400, 401, 403, 422],
  })
  build(@Ctx() auth: AuthContext, @Body() body: BuildBody) {
    return this.datasets.build(actorOf(auth), body);
  }

  @Post('training-runs')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'Train a model on a dataset (queued; intel trains, the API registers the version)',
    operationId: 'startScoringMlTraining',
    body: TrainBody,
    response: { status: 201, schema: MlTrainingRunSchema },
    errors: [400, 401, 403, 404],
  })
  train(@Ctx() auth: AuthContext, @Body() body: TrainBody) {
    return this.trainer.start(actorOf(auth), body);
  }

  @Get('training-runs')
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'Training runs, newest first, with their status',
    operationId: 'listScoringMlTrainingRuns',
    response: { status: 200, schema: MlTrainingRunListSchema },
    errors: [401, 403],
  })
  async runs(@Ctx() auth: AuthContext) {
    return { items: await this.trainer.runs(actorOf(auth).organizationId) };
  }

  @Get('models')
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'Trained model versions with their metrics and model cards',
    operationId: 'listScoringMlModels',
    response: { status: 200, schema: MlModelListSchema },
    errors: [401, 403],
  })
  async models(@Ctx() auth: AuthContext) {
    return { items: await this.trainer.models(actorOf(auth).organizationId) };
  }

  @Get('models/:id')
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'One model version',
    operationId: 'getScoringMlModel',
    response: { status: 200, schema: MlModelSchema },
    errors: [401, 403, 404],
  })
  model(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.trainer.model(actorOf(auth).organizationId, id);
  }

  @Get('shadow')
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'The models running in shadow, per profile',
    operationId: 'listScoringShadowModels',
    response: { status: 200, schema: ShadowAssignmentListSchema },
    errors: [401, 403],
  })
  async shadowList(@Ctx() auth: AuthContext) {
    return { items: await this.shadows.list(actorOf(auth).organizationId) };
  }

  @Put('shadow')
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'Run a model in shadow beside a profile (null withdraws it); the profile is recomputed',
    operationId: 'setScoringShadowModel',
    body: ShadowBody,
    response: { status: 200, schema: ShadowAssignmentListSchema },
    errors: [400, 401, 403, 404, 409],
  })
  async setShadow(@Ctx() auth: AuthContext, @Body() body: ShadowBody) {
    return { items: await this.shadows.set(actorOf(auth), body) };
  }

  @Get('businesses/:id/shadow-scores')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'A business’s latest shadow scores (labelled shadow in the Scores tab)',
    operationId: 'getBusinessShadowScores',
    response: { status: 200, schema: ShadowScoreListSchema },
    errors: [401, 403],
  })
  async businessShadows(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { items: await this.shadows.forBusiness(actorOf(auth).organizationId, id) };
  }

  @Get('profiles/:profileId/comparison')
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'The shadow model against the active profile on contacts made since the shadow started',
    operationId: 'getScoringProspectiveComparison',
    response: { status: 200, schema: ProspectiveComparisonSchema },
    errors: [401, 403, 404, 409],
  })
  compare(@Ctx() auth: AuthContext, @Param('profileId', ParseUUIDPipe) profileId: string) {
    return this.comparison.compare(actorOf(auth).organizationId, profileId);
  }

  @Get('promotions')
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'Model promotions and rollbacks, newest first',
    operationId: 'listScoringPromotions',
    response: { status: 200, schema: ModelPromotionListSchema },
    errors: [401, 403],
  })
  async promotionList(@Ctx() auth: AuthContext) {
    return { items: await this.promotions.list(actorOf(auth).organizationId) };
  }

  @Post('promotions')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary:
      'Promote the shadow model to its profile (409 when the criteria are not met and no reason is given)',
    operationId: 'promoteScoringModel',
    body: PromoteBody,
    response: { status: 201, schema: ModelPromotionSchema },
    errors: [400, 401, 403, 404, 409, 422],
  })
  promote(@Ctx() auth: AuthContext, @Body() body: PromoteBody) {
    return this.promotions.promote(actorOf(auth), body);
  }

  @Post('rollbacks')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'Restore the profile version a promotion replaced',
    operationId: 'rollbackScoringModel',
    body: RollbackBody,
    response: { status: 201, schema: ModelPromotionSchema },
    errors: [400, 401, 403, 404],
  })
  rollback(@Ctx() auth: AuthContext, @Body() body: RollbackBody) {
    return this.promotions.rollback(actorOf(auth), body);
  }

  @Get('models/:id/monitoring')
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'The latest drift and decay check of a model',
    operationId: 'getScoringModelMonitoring',
    response: { status: 200, schema: ModelMonitoringResultSchema },
    errors: [401, 403],
  })
  async monitoring(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { latest: (await this.monitor.latest(actorOf(auth).organizationId, id)) ?? null };
  }

  @Post('models/:id/monitoring')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequirePermission('scoring:manage')
  @ApiRoute({
    summary: 'Check a model for drift and decay now (owners are notified on alerts)',
    operationId: 'runScoringModelMonitoring',
    response: { status: 201, schema: ModelMonitoringSchema },
    errors: [401, 403, 404],
  })
  runMonitoring(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.monitor.run(actorOf(auth).organizationId, id);
  }
}
