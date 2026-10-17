import {
  CheckSuppressionRequestSchema,
  CheckSuppressionResponseSchema,
  type ComplianceDecision,
  ComplianceDecisionPageSchema,
  ComplianceDecisionSchema,
  CreateSuppressionRequestSchema,
  CurrentSuppressionPageSchema,
  EvaluateComplianceRequestSchema,
  ImportSuppressionsRequestSchema,
  ImportSuppressionsResultSchema,
  RevokeSuppressionRequestSchema,
  SuppressionPageSchema,
  type SuppressionQuery,
  SuppressionQuerySchema,
} from '@bf/contracts';
import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { ComplianceService } from '../../application/compliance.service.ts';
import { SuppressionAdmin } from '../../application/suppression-admin.ts';

class EvaluateBody extends zodDto(EvaluateComplianceRequestSchema) {}
class SuppressBody extends zodDto(CreateSuppressionRequestSchema) {}
class CheckBody extends zodDto(CheckSuppressionRequestSchema) {}
class RevokeBody extends zodDto(RevokeSuppressionRequestSchema) {}
class ImportBody extends zodDto(ImportSuppressionsRequestSchema) {}
class QueryDto extends zodDto(SuppressionQuerySchema) {}

function orgOf(auth: AuthContext): string {
  if (!auth.orgId) throw new Error('Compliance route reached without a workspace');
  return auth.orgId;
}
const actorOf = (auth: AuthContext) =>
  auth.userId ? { type: 'user', id: auth.userId } : { type: 'api_key', id: auth.apiKeyId };

/** The compliance gate's preview, a business's decisions, and the suppression list (BF-049). */
@ApiTags('compliance')
@Controller()
export class ComplianceController {
  constructor(
    private readonly compliance: ComplianceService,
    private readonly admin: SuppressionAdmin,
  ) {}

  @Post('compliance/evaluate')
  @HttpCode(200)
  @RequirePermission('outreach:send')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiRoute({
    summary: 'Preview the compliance decision for a business, contact, channel and offer (not persisted)',
    operationId: 'evaluateCompliance',
    body: EvaluateBody,
    response: { status: 200, schema: ComplianceDecisionSchema },
    errors: [400, 401, 403, 404, 422],
  })
  evaluate(@Ctx() auth: AuthContext, @Body() body: EvaluateBody): Promise<ComplianceDecision> {
    return this.compliance.evaluate(
      { organizationId: orgOf(auth), businessId: body.businessId, contactId: body.contactId },
      body.channel,
      { purpose: body.purpose, stage: 'preview' },
    );
  }

  @Get('compliance/decisions')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'A business’s persisted compliance decisions, newest first, with their inputs',
    operationId: 'listComplianceDecisions',
    response: { status: 200, schema: ComplianceDecisionPageSchema },
    errors: [400, 401, 403],
  })
  async decisions(@Ctx() auth: AuthContext, @Query('businessId', ParseUUIDPipe) businessId: string) {
    return { items: await this.compliance.history(orgOf(auth), businessId) };
  }

  @Get('suppressions')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'What is suppressed now (the workspace’s entries and the global ones), newest first, filtered',
    operationId: 'listSuppressions',
    query: QueryDto,
    response: { status: 200, schema: CurrentSuppressionPageSchema },
    errors: [400, 401, 403],
  })
  current(@Ctx() auth: AuthContext, @Query() query: QueryDto) {
    return this.admin.current(orgOf(auth), query as SuppressionQuery);
  }

  @Get('suppressions/log')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'The workspace’s suppression log (every add and revoke), newest first, filtered',
    operationId: 'listSuppressionLog',
    query: QueryDto,
    response: { status: 200, schema: SuppressionPageSchema },
    errors: [400, 401, 403],
  })
  log(@Ctx() auth: AuthContext, @Query() query: QueryDto) {
    return this.admin.log(orgOf(auth), query as SuppressionQuery);
  }

  @Get('suppressions/export.csv')
  @RequirePermission('settings:manage')
  @ApiProduces('text/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="suppressions.csv"')
  @Header('Cache-Control', 'no-store')
  @ApiRoute({
    summary: 'Export the current suppressions as CSV (audited)',
    operationId: 'exportSuppressions',
    query: QueryDto,
    response: { status: 200, schema: null },
    errors: [400, 401, 403],
  })
  exportCsv(@Ctx() auth: AuthContext, @Query() query: QueryDto): Promise<string> {
    return this.admin.exportCsv(orgOf(auth), query as SuppressionQuery);
  }

  @Post('suppressions/import')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Import suppressions from CSV (dry run by default: preview counts, then commit)',
    operationId: 'importSuppressions',
    body: ImportBody,
    response: { status: 200, schema: ImportSuppressionsResultSchema },
    errors: [400, 401, 403, 422],
  })
  import(@Ctx() auth: AuthContext, @Body() body: ImportBody) {
    return this.admin.import(orgOf(auth), actorOf(auth), body);
  }

  @Post('suppressions')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Suppress an email, domain, phone or business for the workspace',
    operationId: 'createSuppression',
    body: SuppressBody,
    response: { status: 201, schema: null },
    errors: [400, 401, 403, 422],
  })
  create(@Ctx() auth: AuthContext, @Body() body: SuppressBody) {
    return this.compliance.suppress({
      organizationId: orgOf(auth),
      scope: body.scope,
      value: body.value,
      reason: body.reason ?? 'manual',
      source: 'admin',
      actor: actorOf(auth),
      note: body.note ?? null,
    });
  }

  @Post('suppressions/check')
  @HttpCode(200)
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Which of these keys are suppressed for the workspace',
    operationId: 'checkSuppressions',
    body: CheckBody,
    response: { status: 200, schema: CheckSuppressionResponseSchema },
    errors: [400, 401, 403],
  })
  async check(@Ctx() auth: AuthContext, @Body() body: CheckBody) {
    const hits = await this.compliance.isSuppressed(orgOf(auth), body.keys);
    return { suppressed: hits.map(({ scope, value, reason }) => ({ scope, value, reason })) };
  }

  @Post('suppressions/:id/revoke')
  @HttpCode(200)
  @RequirePermission('compliance:manage')
  @ApiRoute({
    summary: 'Lift a workspace suppression (audited)',
    operationId: 'revokeSuppression',
    body: RevokeBody,
    response: { status: 200, schema: null },
    errors: [400, 401, 403, 404],
  })
  async revoke(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RevokeBody) {
    return {
      revoked: await this.compliance.revoke(orgOf(auth), id, actorOf(auth), body.note, body.consentEvidence),
    };
  }
}
