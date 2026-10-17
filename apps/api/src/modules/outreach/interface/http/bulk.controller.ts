import {
  ApproveBulkRequestSchema,
  BulkActionResultSchema,
  BulkRunDetailSchema,
  BulkRunListSchema,
  BulkRunSchema,
  RejectBulkRequestSchema,
  StartBulkRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MemberDirectory } from '../../../identity/index.ts';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import type { DraftActor } from '../../application/drafting/drafts.service.ts';
import { BulkOutreach } from '../../application/outbound/bulk.ts';

class StartBody extends zodDto(StartBulkRequestSchema) {}
class ApproveBody extends zodDto(ApproveBulkRequestSchema) {}
class RejectBody extends zodDto(RejectBulkRequestSchema) {}

/**
 * Bulk outreach and its approval queue (BF-052): drafts for up to 100 businesses, each judged by the compliance
 * gate; nothing is sent until a person approves it (or every auto-send condition holds).
 */
@ApiTags('outreach')
@Controller('outreach/bulk')
export class BulkController {
  constructor(
    private readonly bulk: BulkOutreach,
    private readonly members: MemberDirectory,
  ) {}

  private async actor(auth: AuthContext): Promise<DraftActor> {
    if (!auth.orgId) throw new Error('Outreach route reached without a workspace');
    const contact = auth.userId ? await this.members.contact(auth.userId) : undefined;
    return {
      organizationId: auth.orgId,
      userId: auth.userId,
      locale: contact?.locale === 'fr' ? 'fr' : 'en',
    };
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Draft emails for up to 100 businesses into the approval queue',
    operationId: 'startBulkOutreach',
    body: StartBody,
    response: { status: 201, schema: BulkRunSchema },
    errors: [400, 401, 403, 422],
  })
  async start(@Ctx() auth: AuthContext, @Body() body: StartBody) {
    return this.bulk.start(await this.actor(auth), body, auth.permissions.has('outreach:auto_send'));
  }

  @Get()
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'The workspace’s bulk runs, newest first',
    operationId: 'listBulkRuns',
    response: { status: 200, schema: BulkRunListSchema },
    errors: [401, 403],
  })
  async list(@Ctx() auth: AuthContext) {
    return { items: await this.bulk.list(await this.actor(auth)) };
  }

  @Get(':id')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary:
      'A bulk run: its items (rendered previews, compliance) and the businesses it skipped, with reasons',
    operationId: 'getBulkRun',
    response: { status: 200, schema: BulkRunDetailSchema },
    errors: [401, 403, 404],
  })
  async detail(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.bulk.detail(await this.actor(auth), id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Approve items (or all pending, with the confirmed count): each is judged again, then queued',
    operationId: 'approveBulkItems',
    body: ApproveBody,
    response: { status: 200, schema: BulkActionResultSchema },
    errors: [400, 401, 403, 404, 409],
  })
  async approve(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ApproveBody) {
    return this.bulk.approve(await this.actor(auth), id, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Reject items: they are cancelled and never sent',
    operationId: 'rejectBulkItems',
    body: RejectBody,
    response: { status: 200, schema: BulkActionResultSchema },
    errors: [400, 401, 403, 404],
  })
  async reject(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RejectBody) {
    return this.bulk.reject(await this.actor(auth), id, body.messageIds);
  }
}
