import {
  ConnectSmtpMailboxRequestSchema,
  type Mailbox,
  type MailboxDetail,
  MailboxDetailSchema,
  MailboxListSchema,
  MailboxSchema,
  type MailboxTestResult,
  MailboxTestResultSchema,
  PauseMailboxRequestSchema,
  UpdateMailboxRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MemberDirectory } from '../../../identity/index.ts';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { type MailboxActor, MailboxesService } from '../../application/mailbox/mailboxes.service.ts';

class ConnectSmtpBody extends zodDto(ConnectSmtpMailboxRequestSchema) {}
class UpdateBody extends zodDto(UpdateMailboxRequestSchema) {}
class PauseBody extends zodDto(PauseMailboxRequestSchema) {}

/** The workspace's sending mailboxes (BF-050). Members connect their own; admins manage shared ones and the caps. */
@ApiTags('mailboxes')
@Controller('mailboxes')
export class MailboxesController {
  constructor(
    private readonly mailboxes: MailboxesService,
    private readonly members: MemberDirectory,
  ) {}

  private async actor(auth: AuthContext): Promise<MailboxActor> {
    if (!auth.orgId) throw new Error('Mailbox route reached without a workspace');
    const contact = auth.userId ? await this.members.contact(auth.userId) : undefined;
    return {
      organizationId: auth.orgId,
      userId: auth.userId,
      email: contact?.email ?? null,
      locale: contact?.locale ?? 'en',
      manage: auth.permissions.has('settings:manage'),
    };
  }

  @Get()
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'The workspace’s mailboxes with today’s cap and usage',
    operationId: 'listMailboxes',
    response: { status: 200, schema: MailboxListSchema },
    errors: [401, 403],
  })
  async list(@Ctx() auth: AuthContext): Promise<{ items: Mailbox[] }> {
    return this.mailboxes.list(await this.actor(auth));
  }

  @Get(':id')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'One mailbox: status, cap, usage (30 days + ramp plan), next window, health and its trail',
    operationId: 'getMailbox',
    response: { status: 200, schema: MailboxDetailSchema },
    errors: [401, 403, 404],
  })
  async get(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<MailboxDetail> {
    return this.mailboxes.get(await this.actor(auth), id);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary:
      'Connect an SMTP + IMAP mailbox (tested live before it is saved; the password goes to the vault)',
    operationId: 'connectSmtpMailbox',
    body: ConnectSmtpBody,
    response: { status: 201, schema: MailboxSchema },
    errors: [400, 401, 403, 422],
  })
  async connectSmtp(@Ctx() auth: AuthContext, @Body() body: ConnectSmtpBody): Promise<Mailbox> {
    return this.mailboxes.connectSmtp(await this.actor(auth), body);
  }

  @Patch(':id')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary:
      'Change a mailbox’s name, signature, languages, reply-to (owner) or caps, ramp and window (admins)',
    operationId: 'updateMailbox',
    body: UpdateBody,
    response: { status: 200, schema: MailboxSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async update(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateBody,
  ): Promise<Mailbox> {
    return this.mailboxes.update(await this.actor(auth), id, body);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Pause sending from a mailbox',
    operationId: 'pauseMailbox',
    body: PauseBody,
    response: { status: 200, schema: MailboxSchema },
    errors: [401, 403, 404, 409],
  })
  async pause(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PauseBody,
  ): Promise<Mailbox> {
    return this.mailboxes.pause(await this.actor(auth), id, body.reason);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Resume a paused mailbox (after a passing health check)',
    operationId: 'resumeMailbox',
    response: { status: 200, schema: MailboxSchema },
    errors: [401, 403, 404, 409, 422],
  })
  async resume(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<Mailbox> {
    return this.mailboxes.resume(await this.actor(auth), id);
  }

  @Post(':id/test')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Send a test message from the mailbox to your own address',
    operationId: 'testMailbox',
    response: { status: 200, schema: MailboxTestResultSchema },
    errors: [401, 403, 404],
  })
  async test(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<MailboxTestResult> {
    return this.mailboxes.sendTest(await this.actor(auth), id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Disconnect a mailbox (credentials purged from the vault; its history is kept)',
    operationId: 'disconnectMailbox',
    response: { status: 204, schema: null },
    errors: [401, 403, 404],
  })
  async disconnect(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.mailboxes.disconnect(await this.actor(auth), id);
  }
}
