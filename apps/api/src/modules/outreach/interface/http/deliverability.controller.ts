import { DomainCheckSchema, ReadinessListSchema, ReadinessOverrideRequestSchema } from '@bf/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { DeliverabilityService } from '../../application/deliverability/deliverability.service.ts';

class OverrideBody extends zodDto(ReadinessOverrideRequestSchema) {}

const orgOf = (auth: AuthContext) => {
  if (!auth.orgId) throw new Error('Deliverability route reached without a workspace');
  return auth.orgId;
};

/**
 * Deliverability (BF-056): each mailbox's domain authentication (SPF, DKIM, DMARC, MX; MTA-STS, TLS-RPT, BIMI) with
 * fix instructions, whether it may send, an on-demand re-check, and an owner's audited override.
 */
@ApiTags('outreach')
@Controller('deliverability')
export class DeliverabilityController {
  constructor(private readonly deliverability: DeliverabilityService) {}

  @Get('mailboxes')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Each mailbox’s readiness: its domain checks, what blocks sending, and any override',
    operationId: 'listMailboxReadiness',
    response: { status: 200, schema: ReadinessListSchema },
    errors: [401, 403],
  })
  async readiness(@Ctx() auth: AuthContext) {
    return { items: await this.deliverability.readiness(orgOf(auth)) };
  }

  @Post('mailboxes/:id/check')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Check the mailbox’s domain again now (DNS, with timeouts)',
    operationId: 'recheckMailboxDomain',
    response: { status: 200, schema: DomainCheckSchema },
    errors: [401, 403, 404, 429],
  })
  async recheck(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.deliverability.recheck(orgOf(auth), id);
  }

  @Put('mailboxes/:id/override')
  @HttpCode(204)
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Let this mailbox send despite failing checks (owners; a reason is required and audited)',
    operationId: 'overrideMailboxReadiness',
    body: OverrideBody,
    response: { status: 204, schema: null },
    errors: [400, 401, 403, 404, 422],
  })
  async override(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: OverrideBody,
  ) {
    await this.deliverability.setOverride(orgOf(auth), id, body.reason, auth.userId);
  }

  @Delete('mailboxes/:id/override')
  @HttpCode(204)
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Remove the override (the checks decide again)',
    operationId: 'clearMailboxReadinessOverride',
    response: { status: 204, schema: null },
    errors: [401, 403, 404],
  })
  async clear(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.deliverability.clearOverride(orgOf(auth), id);
  }
}
