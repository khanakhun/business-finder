import {
  EditPendingMessageRequestSchema,
  type ListOutboundMessagesQuery,
  ListOutboundMessagesQuerySchema,
  ManualContactLogSchema,
  ManualLogRequestSchema,
  type OutboundMessage,
  OutboundMessageListSchema,
  OutboundMessageSchema,
  OutboundMessageSummarySchema,
  RescheduleMessageRequestSchema,
  SendMessageRequestSchema,
  ValidationError,
} from '@bf/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { MemberDirectory } from '../../../identity/index.ts';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import type { DraftActor } from '../../application/drafting/drafts.service.ts';
import { BulkOutreach } from '../../application/outbound/bulk.ts';
import { ManualContactLogs } from '../../application/outbound/manual-log.ts';
import { OutboundCommands } from '../../application/outbound/outbound.commands.ts';
import { OutboundQueries } from '../../application/outbound/outbound.queries.ts';

class SendBody extends zodDto(SendMessageRequestSchema) {}
class RescheduleBody extends zodDto(RescheduleMessageRequestSchema) {}
class ManualLogBody extends zodDto(ManualLogRequestSchema) {}
class ListQuery extends zodDto(ListOutboundMessagesQuerySchema) {}
class EditBody extends zodDto(EditPendingMessageRequestSchema) {}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,200}$/;

const BusinessMessagesSchema = z
  .object({ messages: z.array(OutboundMessageSummarySchema), manual: z.array(ManualContactLogSchema) })
  .meta({ id: 'BusinessOutreachHistory' });

/**
 * One-click send and the outbox (BF-052). Sending needs an `Idempotency-Key`; the compliance gate answers 409
 * (manual only: copy and log it) or 422 (blocked) with its reasons and alternatives.
 */
@ApiTags('outreach')
@Controller('outreach')
export class MessagesController {
  constructor(
    private readonly commands: OutboundCommands,
    private readonly queries: OutboundQueries,
    private readonly manual: ManualContactLogs,
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

  @Post('messages')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary:
      'Send a draft: queued after the undo window (`Idempotency-Key` header required; the same key returns the same message)',
    operationId: 'sendOutboundMessage',
    body: SendBody,
    response: { status: 201, schema: OutboundMessageSchema },
    errors: [400, 401, 403, 404, 409, 422],
  })
  async send(
    @Ctx() auth: AuthContext,
    @Body() body: SendBody,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OutboundMessage> {
    if (!key || !IDEMPOTENCY_KEY.test(key))
      throw new ValidationError('An Idempotency-Key header is required.', [
        { path: ['Idempotency-Key'], message: '8–200 characters [A-Za-z0-9_.:-]' },
      ]);
    const actor = await this.actor(auth);
    const { message, created } = await this.commands.send(actor, body, key);
    res.status(created ? 201 : 200);
    return this.queries.get(actor.organizationId, message.id);
  }

  @Get('messages')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'The outbox: messages by status, mailbox, business and date, newest first',
    operationId: 'listOutboundMessages',
    query: ListQuery,
    response: { status: 200, schema: OutboundMessageListSchema },
    errors: [400, 401, 403],
  })
  async list(@Ctx() auth: AuthContext, @Query() query: ListQuery) {
    return this.queries.list((await this.actor(auth)).organizationId, query as ListOutboundMessagesQuery);
  }

  @Get('messages/:id')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'One message: its content, headers, compliance decisions and timeline',
    operationId: 'getOutboundMessage',
    response: { status: 200, schema: OutboundMessageSchema },
    errors: [401, 403, 404],
  })
  async get(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.queries.get((await this.actor(auth)).organizationId, id);
  }

  @Patch('messages/:id')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Edit a message waiting for approval (its draft changes and the preview is rendered again)',
    operationId: 'editPendingMessage',
    body: EditBody,
    response: { status: 200, schema: OutboundMessageSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async edit(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: EditBody) {
    const actor = await this.actor(auth);
    await this.bulk.edit(actor, id, body);
    return this.queries.get(actor.organizationId, id);
  }

  @Post('messages/:id/approve')
  @HttpCode(200)
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Approve a message waiting for approval: judged again, then queued (refused ones are cancelled)',
    operationId: 'approveOutboundMessage',
    response: { status: 200, schema: OutboundMessageSchema },
    errors: [401, 403, 404, 409, 422],
  })
  async approve(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const actor = await this.actor(auth);
    await this.commands.approveOne(actor, id);
    return this.queries.get(actor.organizationId, id);
  }

  @Post('messages/:id/cancel')
  @HttpCode(200)
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Cancel a queued message (the undo toast)',
    operationId: 'cancelOutboundMessage',
    response: { status: 200, schema: OutboundMessageSchema },
    errors: [401, 403, 404, 409],
  })
  async cancel(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const actor = await this.actor(auth);
    await this.commands.cancel(actor, id);
    return this.queries.get(actor.organizationId, id);
  }

  @Post('messages/:id/reschedule')
  @HttpCode(200)
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Move a queued message to another time',
    operationId: 'rescheduleOutboundMessage',
    body: RescheduleBody,
    response: { status: 200, schema: OutboundMessageSchema },
    errors: [400, 401, 403, 404, 409],
  })
  async reschedule(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RescheduleBody,
  ) {
    const actor = await this.actor(auth);
    await this.commands.reschedule(actor, id, body);
    return this.queries.get(actor.organizationId, id);
  }

  @Post('messages/:id/retry')
  @HttpCode(200)
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Queue a failed message again (attempts left)',
    operationId: 'retryOutboundMessage',
    response: { status: 200, schema: OutboundMessageSchema },
    errors: [401, 403, 404, 409],
  })
  async retry(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const actor = await this.actor(auth);
    await this.commands.retry(actor, id);
    return this.queries.get(actor.organizationId, id);
  }

  @Post('manual-log')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Log a contact made by hand (refused for a suppressed or do-not-contact business)',
    operationId: 'logManualContact',
    body: ManualLogBody,
    response: { status: 201, schema: ManualContactLogSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async manualLog(@Ctx() auth: AuthContext, @Body() body: ManualLogBody) {
    return this.manual.log(await this.actor(auth), body);
  }

  @Get('history')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'A business’s outreach: its messages and manual contact logs',
    operationId: 'getBusinessOutreachHistory',
    response: { status: 200, schema: BusinessMessagesSchema },
    errors: [400, 401, 403],
  })
  async history(@Ctx() auth: AuthContext, @Query('businessId', ParseUUIDPipe) businessId: string) {
    const actor = await this.actor(auth);
    const [messages, manual] = await Promise.all([
      this.queries.forBusiness(actor.organizationId, businessId),
      this.manual.forBusiness(actor, businessId),
    ]);
    return { messages, manual };
  }
}
