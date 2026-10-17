import {
  CheckSuppressionRequestSchema,
  CheckSuppressionResponseSchema,
  type ComplianceDecision,
  ComplianceDecisionPageSchema,
  ComplianceDecisionSchema,
  CreateSuppressionRequestSchema,
  EvaluateComplianceRequestSchema,
  RevokeSuppressionRequestSchema,
  SuppressionPageSchema,
} from '@bf/contracts';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { ComplianceService } from '../../application/compliance.service.ts';
import { SUPPRESSION_REPOSITORY, type SuppressionRepository } from '../../application/ports.ts';

class EvaluateBody extends zodDto(EvaluateComplianceRequestSchema) {}
class SuppressBody extends zodDto(CreateSuppressionRequestSchema) {}
class CheckBody extends zodDto(CheckSuppressionRequestSchema) {}
class RevokeBody extends zodDto(RevokeSuppressionRequestSchema) {}

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
    @Inject(SUPPRESSION_REPOSITORY) private readonly suppressions: SuppressionRepository,
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
  @RequirePermission('compliance:manage')
  @ApiRoute({
    summary: 'The workspace’s suppression log, newest first',
    operationId: 'listSuppressions',
    response: { status: 200, schema: SuppressionPageSchema },
    errors: [401, 403],
  })
  async list(@Ctx() auth: AuthContext, @Query('before') before: string | undefined) {
    const at = before ? new Date(before) : undefined;
    const rows = await this.suppressions.list(orgOf(auth), {
      limit: 100,
      ...(at && !Number.isNaN(at.getTime()) ? { before: at } : {}),
    });
    return {
      items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      nextCursor: rows.length === 100 ? (rows.at(-1)?.createdAt.toISOString() ?? null) : null,
    };
  }

  @Post('suppressions')
  @RequirePermission('compliance:manage')
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
    return { revoked: await this.compliance.revoke(orgOf(auth), id, actorOf(auth), body.note) };
  }
}
