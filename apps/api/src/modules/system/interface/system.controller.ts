import { type SystemInfo, SystemInfoSchema } from '@bf/contracts';
import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiRoute } from '../../platform/validation/api-route.decorator.ts';
import { GetSystemInfoQuery } from '../application/get-system-info.query.ts';

/** Interface layer: parse, (authorise — BF-010), delegate. No logic here. */
@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(private readonly getSystemInfo: GetSystemInfoQuery) {}

  @Get('info')
  @ApiRoute({
    summary: 'Build and runtime information',
    operationId: 'getSystemInfo',
    response: { status: 200, schema: SystemInfoSchema },
  })
  info(): SystemInfo {
    return this.getSystemInfo.execute();
  }
}
