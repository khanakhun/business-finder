import {
  type DiscoveryProviderList,
  DiscoveryProviderListSchema,
  ProviderUsageQuerySchema,
  type ProviderUsageReport,
  ProviderUsageReportSchema,
  type ScraperStatus,
  ScraperStatusSchema,
} from '@bf/contracts';
import { Body, Controller, Delete, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { DiscoveryQueries } from '../../application/discovery.services.ts';
import { ScraperAcknowledgement } from '../../application/scraper-acknowledgement.ts';

class UsageQueryDto extends zodDto(ProviderUsageQuerySchema) {}
class AcknowledgeBody extends zodDto(z.object({ warningVersion: z.number().int().min(1) })) {}

/** Discovery providers and their metered usage (BF-018). Runs come with BF-020. */
@ApiTags('discovery')
@Controller('discovery')
export class DiscoveryController {
  constructor(
    private readonly queries: DiscoveryQueries,
    private readonly scraper: ScraperAcknowledgement,
  ) {}

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

  @Get('scraper')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary:
      'Google Maps scraper gates: deployment switch, workspace flag, owner acknowledgement, warning text',
    operationId: 'getScraperStatus',
    response: { status: 200, schema: ScraperStatusSchema },
    errors: [401, 403],
  })
  scraperStatus(@Ctx() auth: AuthContext): Promise<ScraperStatus> {
    return this.scraper.status(auth);
  }

  @Post('scraper/acknowledgement')
  @HttpCode(200)
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Acknowledge the scraper ToS warning (workspace owner only; recorded in the audit log)',
    operationId: 'acknowledgeScraperWarning',
    body: AcknowledgeBody,
    response: { status: 200, schema: ScraperStatusSchema },
    errors: [400, 401, 403],
  })
  acknowledge(@Ctx() auth: AuthContext, @Body() body: AcknowledgeBody): Promise<ScraperStatus> {
    return this.scraper.acknowledge(auth, body.warningVersion);
  }

  @Delete('scraper/acknowledgement')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Withdraw the scraper acknowledgement (workspace owner only)',
    operationId: 'revokeScraperAcknowledgement',
    response: { status: 200, schema: ScraperStatusSchema },
    errors: [401, 403],
  })
  revoke(@Ctx() auth: AuthContext): Promise<ScraperStatus> {
    return this.scraper.revoke(auth);
  }
}
