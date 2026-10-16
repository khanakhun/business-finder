import {
  CursorPageRequestSchema,
  type DiscoveryRun,
  type DiscoveryRunEstimate,
  DiscoveryRunEstimateSchema,
  type DiscoveryRunPage,
  DiscoveryRunPageSchema,
  DiscoveryRunQuerySchema,
  DiscoveryRunSchema,
  type DiscoveryTaskPage,
  DiscoveryTaskPageSchema,
  EstimateDiscoveryRunRequestSchema,
  type RunBusinessPage,
  RunBusinessPageSchema,
  StartDiscoveryRunRequestSchema,
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
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import {
  CancelDiscoveryRunCommand,
  DiscoveryRunQueries,
  EstimateDiscoveryRunQuery,
  StartDiscoveryRunCommand,
} from '../../application/run.use-cases.ts';

class EstimateBody extends zodDto(EstimateDiscoveryRunRequestSchema) {}
class StartBody extends zodDto(StartDiscoveryRunRequestSchema) {}
class RunQueryDto extends zodDto(DiscoveryRunQuerySchema) {}
class PageQueryDto extends zodDto(CursorPageRequestSchema) {}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,200}$/;

/** Discovery runs (BF-020): estimate, start, follow, cancel. */
@ApiTags('discovery')
@Controller('discovery-runs')
export class DiscoveryRunsController {
  constructor(
    private readonly estimateQuery: EstimateDiscoveryRunQuery,
    private readonly startCommand: StartDiscoveryRunCommand,
    private readonly cancelCommand: CancelDiscoveryRunCommand,
    private readonly queries: DiscoveryRunQueries,
  ) {}

  @Post('estimate')
  @HttpCode(200)
  @RequirePermission('discovery:run')
  @ApiRoute({
    summary: 'Tiles, tasks, calls and cost ranges per provider for a discovery run (no side effects)',
    operationId: 'estimateDiscoveryRun',
    body: EstimateBody,
    response: { status: 200, schema: DiscoveryRunEstimateSchema },
    errors: [400, 401, 403, 404, 422],
  })
  estimate(@Ctx() auth: AuthContext, @Body() body: EstimateBody): Promise<DiscoveryRunEstimate> {
    return this.estimateQuery.execute(auth, body);
  }

  @Post()
  @RequirePermission('discovery:run')
  @ApiRoute({
    summary: 'Start a discovery run (`Idempotency-Key` header: the same key returns the same run)',
    operationId: 'startDiscoveryRun',
    body: StartBody,
    response: { status: 201, schema: DiscoveryRunSchema },
    errors: [400, 401, 403, 404, 409, 422],
  })
  async start(
    @Ctx() auth: AuthContext,
    @Body() body: StartBody,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DiscoveryRun> {
    if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
      throw new ValidationError('Invalid Idempotency-Key.', [
        { path: ['Idempotency-Key'], message: '8–200 characters [A-Za-z0-9_.:-]' },
      ]);
    }
    const { run, created } = await this.startCommand.execute(auth, body, key ?? null);
    res.status(created ? 201 : 200);
    return run;
  }

  @Get()
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'Discovery runs of the workspace, newest first',
    operationId: 'listDiscoveryRuns',
    query: RunQueryDto,
    response: { status: 200, schema: DiscoveryRunPageSchema },
    errors: [400, 401, 403],
  })
  list(@Ctx() auth: AuthContext, @Query() query: RunQueryDto): Promise<DiscoveryRunPage> {
    return this.queries.list(auth, query);
  }

  @Get(':id')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'A discovery run with its counts and cost',
    operationId: 'getDiscoveryRun',
    response: { status: 200, schema: DiscoveryRunSchema },
    errors: [401, 403, 404],
  })
  get(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<DiscoveryRun> {
    return this.queries.get(auth, id);
  }

  @Get(':id/tasks')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Provider tasks of a run (debugging)',
    operationId: 'listDiscoveryRunTasks',
    query: PageQueryDto,
    response: { status: 200, schema: DiscoveryTaskPageSchema },
    errors: [400, 401, 403, 404],
  })
  tasks(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PageQueryDto,
  ): Promise<DiscoveryTaskPage> {
    return this.queries.tasks(auth, id, query);
  }

  @Get(':id/businesses')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'Businesses this run added to the workspace',
    operationId: 'listDiscoveryRunBusinesses',
    query: PageQueryDto,
    response: { status: 200, schema: RunBusinessPageSchema },
    errors: [400, 401, 403, 404],
  })
  businesses(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PageQueryDto,
  ): Promise<RunBusinessPage> {
    return this.queries.businesses(auth, id, query);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('discovery:run')
  @ApiRoute({
    summary: 'Cancel a run: no new provider calls; in-flight calls stop at their next checkpoint',
    operationId: 'cancelDiscoveryRun',
    response: { status: 200, schema: DiscoveryRunSchema },
    errors: [401, 403, 404],
  })
  cancel(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<DiscoveryRun> {
    return this.cancelCommand.execute(auth, id);
  }
}
