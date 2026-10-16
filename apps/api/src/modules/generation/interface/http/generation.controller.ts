import {
  CreateGenerationBatchRequestSchema,
  type GenerationBatchDetail,
  GenerationBatchDetailSchema,
  GenerationBatchListQuerySchema,
  type GenerationBatchPage,
  GenerationBatchPageSchema,
  type GenerationEngineListing,
  GenerationEngineListingSchema,
  type GenerationJob,
  type GenerationJobDetail,
  GenerationJobDetailSchema,
  GenerationJobSchema,
  ReorderGenerationJobsRequestSchema,
  RetryGenerationJobRequestSchema,
  UpdateGenerationJobRequestSchema,
  ValidationError,
} from '@bf/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { type GenerationActor, GenerationCommands } from '../../application/generation.commands.ts';
import { GenerationQueries, toJob } from '../../application/generation.queries.ts';

class CreateBody extends zodDto(CreateGenerationBatchRequestSchema) {}
class ListQuery extends zodDto(GenerationBatchListQuerySchema) {}
class UpdateBody extends zodDto(UpdateGenerationJobRequestSchema) {}
class ReorderBody extends zodDto(ReorderGenerationJobsRequestSchema) {}
class RetryBody extends zodDto(RetryGenerationJobRequestSchema) {}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,200}$/;

function actorOf(auth: AuthContext): GenerationActor {
  if (!auth.orgId) throw new Error('Generation route reached without an active workspace');
  return { organizationId: auth.orgId, userId: auth.userId ?? null };
}

/** Site generation (BF-039): batches of jobs, their engines, priorities, cancellation and retries. */
@ApiTags('generation')
@Controller()
export class GenerationController {
  constructor(
    private readonly commands: GenerationCommands,
    private readonly queries: GenerationQueries,
  ) {}

  @Post('generation-batches')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Generate sites for businesses (`Idempotency-Key` header: the same key returns the same batch)',
    operationId: 'createGenerationBatch',
    body: CreateBody,
    response: { status: 201, schema: GenerationBatchDetailSchema },
    errors: [400, 401, 403, 409, 422],
  })
  async create(
    @Ctx() auth: AuthContext,
    @Body() body: CreateBody,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GenerationBatchDetail> {
    if (key !== undefined && !IDEMPOTENCY_KEY.test(key))
      throw new ValidationError('Invalid Idempotency-Key.', [
        { path: ['Idempotency-Key'], message: '8–200 characters [A-Za-z0-9_.:-]' },
      ]);
    const actor = actorOf(auth);
    const { batch, created } = await this.commands.createBatch(actor, body, key ?? null);
    res.status(created ? 201 : 200);
    return this.queries.batch(actor.organizationId, batch.id);
  }

  @Get('generation-batches')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'Generation batches of the workspace, newest first',
    operationId: 'listGenerationBatches',
    query: ListQuery,
    response: { status: 200, schema: GenerationBatchPageSchema },
    errors: [400, 401, 403],
  })
  list(@Ctx() auth: AuthContext, @Query() query: ListQuery): Promise<GenerationBatchPage> {
    return this.queries.batches(actorOf(auth).organizationId, query);
  }

  @Get('generation-batches/:id')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'A batch with its jobs, counts and cost',
    operationId: 'getGenerationBatch',
    response: { status: 200, schema: GenerationBatchDetailSchema },
    errors: [401, 403, 404],
  })
  batch(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<GenerationBatchDetail> {
    return this.queries.batch(actorOf(auth).organizationId, id);
  }

  @Post('generation-batches/:id/cancel')
  @HttpCode(204)
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Cancel every job of the batch that has not finished',
    operationId: 'cancelGenerationBatch',
    response: { status: 204, schema: null },
    errors: [401, 403, 404],
  })
  async cancelBatch(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.commands.cancelBatch(actorOf(auth), id);
  }

  @Get('generation-jobs/:id')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'A job with its attempts',
    operationId: 'getGenerationJob',
    response: { status: 200, schema: GenerationJobDetailSchema },
    errors: [401, 403, 404],
  })
  job(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<GenerationJobDetail> {
    return this.queries.job(actorOf(auth).organizationId, id);
  }

  @Patch('generation-jobs/:id')
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Change a waiting job’s priority or engine',
    operationId: 'updateGenerationJob',
    body: UpdateBody,
    response: { status: 200, schema: GenerationJobSchema },
    errors: [400, 401, 403, 404, 409],
  })
  async update(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateBody,
  ): Promise<GenerationJob> {
    return toJob(await this.commands.update(actorOf(auth), id, body));
  }

  @Post('generation-jobs/reorder')
  @HttpCode(204)
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Order a batch’s waiting jobs (the first runs first)',
    operationId: 'reorderGenerationJobs',
    body: ReorderBody,
    response: { status: 204, schema: null },
    errors: [400, 401, 403, 404],
  })
  async reorder(@Ctx() auth: AuthContext, @Body() body: ReorderBody): Promise<void> {
    await this.commands.reorder(actorOf(auth), body.batchId, body.jobIds);
  }

  @Post('generation-jobs/:id/cancel')
  @HttpCode(200)
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Cancel a job (a running one stops within seconds)',
    operationId: 'cancelGenerationJob',
    response: { status: 200, schema: GenerationJobSchema },
    errors: [401, 403, 404, 409],
  })
  async cancel(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<GenerationJob> {
    return toJob(await this.commands.cancel(actorOf(auth), id));
  }

  @Post('generation-jobs/:id/retry')
  @HttpCode(200)
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Run a failed, cancelled or reviewed job again (on another engine if given)',
    operationId: 'retryGenerationJob',
    body: RetryBody,
    response: { status: 200, schema: GenerationJobSchema },
    errors: [400, 401, 403, 404, 409],
  })
  async retry(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RetryBody,
  ): Promise<GenerationJob> {
    return toJob(await this.commands.retry(actorOf(auth), id, body.engine));
  }

  @Get('generation/engines')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'The engines, their capabilities, availability and load',
    operationId: 'listGenerationEngines',
    response: { status: 200, schema: GenerationEngineListingSchema },
    errors: [401, 403],
  })
  engines(@Ctx() auth: AuthContext): Promise<GenerationEngineListing> {
    return this.queries.listEngines(actorOf(auth).organizationId);
  }
}
