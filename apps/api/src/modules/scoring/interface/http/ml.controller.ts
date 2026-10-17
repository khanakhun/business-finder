import {
  BuildMlDatasetRequestSchema,
  MlDatasetSchema,
  MlModelSchema,
  MlReadinessQuerySchema,
  MlReadinessSchema,
  MlTrainingRunSchema,
  StartMlTrainingRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { DatasetBuilder, type MlActor } from '../../application/ml/dataset-builder.ts';
import { ModelTrainer } from '../../application/ml/model-trainer.ts';

class ReadinessQuery extends zodDto(MlReadinessQuerySchema) {}
class BuildBody extends zodDto(BuildMlDatasetRequestSchema) {}
class TrainBody extends zodDto(StartMlTrainingRequestSchema) {}

const MlDatasetListSchema = z.object({ items: z.array(MlDatasetSchema) }).meta({ id: 'MlDatasetList' });
const MlTrainingRunListSchema = z
  .object({ items: z.array(MlTrainingRunSchema) })
  .meta({ id: 'MlTrainingRunList' });
const MlModelListSchema = z.object({ items: z.array(MlModelSchema) }).meta({ id: 'MlModelList' });

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
}
