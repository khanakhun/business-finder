import { AnalyticsQuerySchema, AnalyticsRegistrySchema, AnalyticsResultSchema } from '@bf/contracts';
import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { MemberDirectory } from '../../../identity/index.ts';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { type AnalyticsActor, AnalyticsQueries } from '../../application/analytics.queries.ts';

class QueryBody extends zodDto(AnalyticsQuerySchema) {}

/**
 * Analytics (BF-058): the metric and dimension definitions, one query contract (validated against them, answered
 * with freshness and sample sizes), and the same query as CSV (audited).
 */
@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly queries: AnalyticsQueries,
    private readonly members: MemberDirectory,
  ) {}

  private async actor(auth: AuthContext): Promise<AnalyticsActor> {
    if (!auth.orgId) throw new Error('Analytics route reached without a workspace');
    const contact = auth.userId ? await this.members.contact(auth.userId) : undefined;
    return { organizationId: auth.orgId, locale: contact?.locale === 'fr' ? 'fr' : 'en' };
  }

  @Get('registry')
  @RequirePermission('analytics:read')
  @ApiRoute({
    summary: 'Every metric and dimension, with how it is calculated',
    operationId: 'getAnalyticsRegistry',
    response: { status: 200, schema: AnalyticsRegistrySchema },
    errors: [401, 403],
  })
  registry() {
    return this.queries.definitions();
  }

  @Post('query')
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @RequirePermission('analytics:read')
  @ApiRoute({
    summary: 'Metrics by dimensions over a period (422 for unknown names or a query past 10 s)',
    operationId: 'queryAnalytics',
    body: QueryBody,
    response: { status: 200, schema: AnalyticsResultSchema },
    errors: [400, 401, 403, 422],
  })
  async query(@Ctx() auth: AuthContext, @Body() body: QueryBody) {
    return this.queries.query(await this.actor(auth), body);
  }

  @Post('export.csv')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('analytics:export')
  @ApiProduces('text/csv')
  @ApiRoute({
    summary: 'The same query as CSV (audited)',
    operationId: 'exportAnalytics',
    body: QueryBody,
    response: { status: 200, schema: null },
    errors: [400, 401, 403, 422],
  })
  async export(@Ctx() auth: AuthContext, @Body() body: QueryBody, @Res() res: Response): Promise<void> {
    const csv = await this.queries.exportCsv(await this.actor(auth), body);
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="analytics.csv"');
    res.setHeader('Cache-Control', 'no-store');
    // BOM: spreadsheets then read accents as UTF-8.
    res.send(`﻿${csv}`);
  }
}
