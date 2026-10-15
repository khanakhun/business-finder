import {
  type PingJobsAccepted,
  PingJobsAcceptedSchema,
  PingJobsRequestSchema,
  type SystemInfo,
  SystemInfoSchema,
} from '@bf/contracts';
import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AllowAnonymous, RequirePermission } from '../../platform/security/auth.decorators.ts';
import { ApiRoute } from '../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../platform/validation/zod-dto.ts';
import { EnqueuePingJobsCommand } from '../application/enqueue-ping-jobs.command.ts';
import { GetSystemInfoQuery } from '../application/get-system-info.query.ts';

class PingJobsBody extends zodDto(PingJobsRequestSchema) {}

/** Interface layer: parse, authorise (decorators), delegate. No logic here. */
@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(
    private readonly getSystemInfo: GetSystemInfoQuery,
    private readonly enqueuePingJobs: EnqueuePingJobsCommand,
  ) {}

  @Get('info')
  // Public: version and environment only, shown by the dashboard's connection card and used by deploy checks.
  @AllowAnonymous()
  @ApiRoute({
    summary: 'Build and runtime information',
    operationId: 'getSystemInfo',
    response: { status: 200, schema: SystemInfoSchema },
  })
  info(): SystemInfo {
    return this.getSystemInfo.execute();
  }

  @Post('ping-jobs')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Enqueue system.ping jobs (queue smoke test)',
    operationId: 'enqueuePingJobs',
    body: PingJobsBody,
    response: { status: 202, schema: PingJobsAcceptedSchema },
  })
  ping(@Body() body: PingJobsBody): Promise<PingJobsAccepted> {
    return this.enqueuePingJobs.execute(body);
  }
}
