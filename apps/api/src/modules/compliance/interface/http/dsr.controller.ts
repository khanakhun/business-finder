import {
  CreateDsrRequestSchema,
  type DsrDiscovery,
  DsrDiscoverySchema,
  type DsrRequest,
  DsrRequestListSchema,
  DsrRequestSchema,
  ExecuteDsrRequestSchema,
  RejectDsrRequestSchema,
  RetentionOverviewSchema,
  RetentionRunSchema,
  VerifyDsrRequestSchema,
} from '@bf/contracts';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { type DsrActor, DsrService } from '../../application/dsr.service.ts';
import { RetentionRunner } from '../../application/retention.ts';

class CreateBody extends zodDto(CreateDsrRequestSchema) {}
class VerifyBody extends zodDto(VerifyDsrRequestSchema) {}
class RejectBody extends zodDto(RejectDsrRequestSchema) {}
class ExecuteBody extends zodDto(ExecuteDsrRequestSchema) {}

function actorOf(auth: AuthContext): DsrActor {
  if (!auth.orgId) throw new Error('DSR route reached without a workspace');
  return { organizationId: auth.orgId, userId: auth.userId };
}

/** Data-subject requests (BF-055): admins open and follow them; owners (`compliance:manage`) carry them out. */
@ApiTags('compliance')
@Controller('compliance')
export class DsrController {
  constructor(
    private readonly dsr: DsrService,
    private readonly retention: RetentionRunner,
  ) {}

  @Get('dsr')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'The workspace’s data-subject requests, newest first',
    operationId: 'listDsrRequests',
    response: { status: 200, schema: DsrRequestListSchema },
    errors: [401, 403],
  })
  list(@Ctx() auth: AuthContext) {
    return this.dsr.list(actorOf(auth));
  }

  @Post('dsr')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Record a data-subject request (deadline: one month)',
    operationId: 'createDsrRequest',
    body: CreateBody,
    response: { status: 201, schema: DsrRequestSchema },
    errors: [400, 401, 403, 422],
  })
  create(@Ctx() auth: AuthContext, @Body() body: CreateBody): Promise<DsrRequest> {
    return this.dsr.create(actorOf(auth), body);
  }

  @Get('dsr/:id')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'One data-subject request with its trail',
    operationId: 'getDsrRequest',
    response: { status: 200, schema: DsrRequestSchema },
    errors: [401, 403, 404],
  })
  get(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<DsrRequest> {
    return this.dsr.get(actorOf(auth), id);
  }

  @Post('dsr/:id/verify')
  @HttpCode(200)
  @RequirePermission('compliance:manage')
  @ApiRoute({
    summary: 'Record how the person’s identity was verified (then the request can be carried out)',
    operationId: 'verifyDsrRequest',
    body: VerifyBody,
    response: { status: 200, schema: DsrRequestSchema },
    errors: [400, 401, 403, 404, 409],
  })
  verify(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: VerifyBody) {
    return this.dsr.verify(actorOf(auth), id, body);
  }

  @Post('dsr/:id/reject')
  @HttpCode(200)
  @RequirePermission('compliance:manage')
  @ApiRoute({
    summary: 'Reject a request (with the reason given to the person)',
    operationId: 'rejectDsrRequest',
    body: RejectBody,
    response: { status: 200, schema: DsrRequestSchema },
    errors: [400, 401, 403, 404, 409],
  })
  reject(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RejectBody) {
    return this.dsr.reject(actorOf(auth), id, body.reason);
  }

  @Post('dsr/:id/discover')
  @HttpCode(200)
  @RequirePermission('compliance:manage')
  @ApiRoute({
    summary: 'Find what every module holds about the person (redacted summaries)',
    operationId: 'discoverDsrRequest',
    response: { status: 200, schema: DsrDiscoverySchema },
    errors: [401, 403, 404],
  })
  discover(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<DsrDiscovery> {
    return this.dsr.discover(actorOf(auth), id);
  }

  @Post('dsr/:id/execute')
  @HttpCode(200)
  @RequirePermission('compliance:manage')
  @ApiRoute({
    summary: 'Carry the request out (export, erase, object, restrict or rectify) and complete it',
    operationId: 'executeDsrRequest',
    body: ExecuteBody,
    response: { status: 200, schema: DsrRequestSchema },
    errors: [400, 401, 403, 404, 409, 422],
  })
  execute(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ExecuteBody) {
    return this.dsr.execute(actorOf(auth), id, body);
  }

  @Get('dsr/:id/export.zip')
  @RequirePermission('compliance:manage')
  @ApiProduces('application/zip')
  @Header('Content-Type', 'application/zip')
  @Header('Content-Disposition', 'attachment; filename="personal-data.zip"')
  @Header('Cache-Control', 'no-store')
  @ApiRoute({
    summary: 'Download an access request’s export (audited)',
    operationId: 'downloadDsrExport',
    response: { status: 200, schema: null },
    errors: [401, 403, 404],
  })
  async download(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    return new StreamableFile(await this.dsr.download(actorOf(auth), id));
  }

  @Get('retention')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'The retention policies and the latest runs',
    operationId: 'getRetentionOverview',
    response: { status: 200, schema: RetentionOverviewSchema },
    errors: [401, 403],
  })
  retentionOverview() {
    return this.retention.overview();
  }

  @Post('retention/dry-run')
  @HttpCode(200)
  @RequirePermission('compliance:manage')
  @ApiRoute({
    summary: 'Count what the retention policies would remove now (nothing is changed)',
    operationId: 'dryRunRetention',
    response: { status: 200, schema: RetentionRunSchema },
    errors: [401, 403],
  })
  dryRun(@Ctx() auth: AuthContext) {
    return this.retention.run(true, auth.userId);
  }
}
