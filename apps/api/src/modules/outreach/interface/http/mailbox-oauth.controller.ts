import {
  MailboxOAuthCallbackQuerySchema,
  MailboxOAuthProvidersSchema,
  MailboxOAuthStartQuerySchema,
  MailboxOAuthStartSchema,
  NotFoundError,
  type OAuthMailboxProvider,
  OAuthMailboxProviderSchema,
} from '@bf/contracts';
import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { MemberDirectory } from '../../../identity/index.ts';
import { AllowAnonymous, Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { MailboxOAuth } from '../../application/mailbox/mailbox-oauth.ts';
import { OAUTH_CLIENTS, type OAuthClientRegistry } from '../../application/mailbox/ports.ts';

class StartQuery extends zodDto(MailboxOAuthStartQuerySchema) {}
class CallbackQuery extends zodDto(MailboxOAuthCallbackQuerySchema) {}

function providerOf(value: string): OAuthMailboxProvider {
  const parsed = OAuthMailboxProviderSchema.safeParse(value);
  if (!parsed.success) throw new NotFoundError('MailboxOAuthProvider', value);
  return parsed.data;
}

/** Connecting Gmail/Workspace and Microsoft 365 mailboxes (BF-050): authorization code + PKCE, signed state. */
@ApiTags('mailboxes')
@Controller('mailboxes/oauth')
export class MailboxOAuthController {
  constructor(
    private readonly oauth: MailboxOAuth,
    private readonly members: MemberDirectory,
    @Inject(OAUTH_CLIENTS) private readonly clients: OAuthClientRegistry,
  ) {}

  @Get('providers')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Which OAuth mailbox providers this deployment has configured',
    operationId: 'listMailboxOAuthProviders',
    response: { status: 200, schema: MailboxOAuthProvidersSchema },
    errors: [401, 403],
  })
  providers(): { google: boolean; microsoft: boolean } {
    return {
      google: this.clients.get('google')?.configured ?? false,
      microsoft: this.clients.get('microsoft')?.configured ?? false,
    };
  }

  @Get(':provider/start')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Start connecting (or reconnecting) a mailbox: the consent URL to open',
    operationId: 'startMailboxOAuth',
    query: StartQuery,
    response: { status: 200, schema: MailboxOAuthStartSchema },
    errors: [400, 401, 403, 404, 503],
  })
  async start(
    @Ctx() auth: AuthContext,
    @Param('provider') provider: string,
    @Query() query: StartQuery,
  ): Promise<{ url: string }> {
    if (!auth.orgId) throw new Error('Mailbox route reached without a workspace');
    const contact = auth.userId ? await this.members.contact(auth.userId) : undefined;
    return this.oauth.start(
      {
        organizationId: auth.orgId,
        userId: auth.userId,
        email: contact?.email ?? null,
        locale: contact?.locale ?? 'en',
        manage: auth.permissions.has('settings:manage'),
      },
      providerOf(provider),
      { shared: Boolean(query.shared), mailboxId: query.mailboxId },
    );
  }

  /**
   * The provider's redirect back (no session cookie is relied on): everything comes from the single-use attempt the
   * signed state points to. Always answers with a redirect to the dashboard's mailbox settings.
   */
  @Get(':provider/callback')
  @AllowAnonymous()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiRoute({
    summary: 'OAuth redirect target (anonymous; signed single-use state); redirects to Settings → Mailboxes',
    operationId: 'mailboxOAuthCallback',
    query: CallbackQuery,
    response: { status: 302, schema: null },
    errors: [400],
  })
  async callback(
    @Param('provider') provider: string,
    @Query() query: CallbackQuery,
    @Res() res: Response,
  ): Promise<void> {
    const target = await this.oauth.callback(providerOf(provider), query);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, target);
  }
}
