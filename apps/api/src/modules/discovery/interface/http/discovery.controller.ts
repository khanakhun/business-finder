import {
  type DiscoveryProviderList,
  DiscoveryProviderListSchema,
  ProviderUsageQuerySchema,
  type ProviderUsageReport,
  ProviderUsageReportSchema,
} from '@bf/contracts';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { DiscoveryQueries } from '../../application/discovery.services.ts';

class UsageQueryDto extends zodDto(ProviderUsageQuerySchema) {}

/** Discovery providers and their metered usage (BF-018). Runs come with BF-020. */
@ApiTags('discovery')
@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly queries: DiscoveryQueries) {}

  @Get('providers')
  @RequirePermission('discovery:run')
  @ApiRoute({
    summary: 'Discovery providers for this workspace: status, capabilities, licensing and cost model',
    operationId: 'listDiscoveryProviders',
    response: { status: 200, schema: DiscoveryProviderListSchema },
    errors: [401, 403],
  })
  providers(@Ctx() auth: AuthContext): Promise<DiscoveryProviderList> {
    return this.queries.providers(auth);
  }

  @Get('usage')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Provider calls, results and estimated cost per day, provider and SKU',
    operationId: 'getDiscoveryUsage',
    query: UsageQueryDto,
    response: { status: 200, schema: ProviderUsageReportSchema },
    errors: [400, 401, 403],
  })
  usage(@Ctx() auth: AuthContext, @Query() query: UsageQueryDto): Promise<ProviderUsageReport> {
    return this.queries.usage(auth, query);
  }
}
