import {
  CorrectTriageRequestSchema,
  EmailDraftSchema,
  InboundMessageSchema,
  type InboxQuery,
  InboxQuerySchema,
  InboxThreadDetailSchema,
  InboxThreadListSchema,
  SuggestReplyRequestSchema,
  UpdateInboundRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MemberDirectory } from '../../../identity/index.ts';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import type { DraftActor } from '../../application/drafting/drafts.service.ts';
import { InboxService } from '../../application/inbound/inbox.ts';

class ListQuery extends zodDto(InboxQuerySchema) {}
class UpdateBody extends zodDto(UpdateInboundRequestSchema) {}
class CorrectBody extends zodDto(CorrectTriageRequestSchema) {}
class SuggestBody extends zodDto(SuggestReplyRequestSchema) {}

/** The unified inbox (BF-054): outreach replies only (the privacy filter dropped everything else unstored). */
@ApiTags('outreach')
@Controller('inbox')
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly members: MemberDirectory,
  ) {}

  private async actor(auth: AuthContext): Promise<DraftActor> {
    if (!auth.orgId) throw new Error('Inbox route reached without a workspace');
    const contact = auth.userId ? await this.members.contact(auth.userId) : undefined;
    return {
      organizationId: auth.orgId,
      userId: auth.userId,
      locale: contact?.locale === 'fr' ? 'fr' : 'en',
    };
  }

  @Get()
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary:
      'Threads with replies: by triage class, mailbox, unread, needs a person, assigned to me, newest first',
    operationId: 'listInboxThreads',
    query: ListQuery,
    response: { status: 200, schema: InboxThreadListSchema },
    errors: [400, 401, 403],
  })
  async list(@Ctx() auth: AuthContext, @Query() query: ListQuery) {
    return this.inbox.list(await this.actor(auth), query as InboxQuery);
  }

  @Get('threads/:threadId')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'A thread: our messages and the replies in order, with their triage',
    operationId: 'getInboxThread',
    response: { status: 200, schema: InboxThreadDetailSchema },
    errors: [401, 403, 404],
  })
  async thread(@Ctx() auth: AuthContext, @Param('threadId', ParseUUIDPipe) threadId: string) {
    return this.inbox.detail(await this.actor(auth), threadId);
  }

  @Patch('messages/:id')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Mark a reply read or handled, snooze it, or assign it',
    operationId: 'updateInboundMessage',
    body: UpdateBody,
    response: { status: 200, schema: InboundMessageSchema },
    errors: [400, 401, 403, 404],
  })
  async update(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateBody) {
    return this.inbox.update(await this.actor(auth), id, body);
  }

  @Post('messages/:id/triage')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Correct a reply’s class: kept as feedback, and the safe actions run again',
    operationId: 'correctReplyTriage',
    body: CorrectBody,
    response: { status: 201, schema: InboundMessageSchema },
    errors: [400, 401, 403, 404],
  })
  async correct(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CorrectBody) {
    return this.inbox.correct(await this.actor(auth), id, body);
  }

  @Post('messages/:id/suggest-reply')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Draft a reply to this message (AI, grounded; edit it, then send it in the thread)',
    operationId: 'suggestReply',
    body: SuggestBody,
    response: { status: 201, schema: EmailDraftSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async suggest(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SuggestBody) {
    return this.inbox.suggestReply(await this.actor(auth), id, body);
  }
}
