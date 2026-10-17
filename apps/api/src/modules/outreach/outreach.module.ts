import { createHmac } from 'node:crypto';
import type { ApiEnv } from '@bf/config';
import type { Clock } from '@bf/contracts';
import { type DynamicModule, Module } from '@nestjs/common';
import { ComplianceModule } from '../compliance/index.ts';
import { CrmModule } from '../crm/index.ts';
import { GenerationModule } from '../generation/index.ts';
import { CLOCK } from '../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { RealtimeModule } from '../realtime/index.ts';
import { DraftsService } from './application/drafting/drafts.service.ts';
import { DRAFT_CONTEXT, DRAFT_REPOSITORY, TEMPLATE_REPOSITORY } from './application/drafting/ports.ts';
import { TemplatesService } from './application/drafting/templates.service.ts';
import { MailboxCapacity } from './application/mailbox/mailbox-capacity.ts';
import { MailboxCredentialStore } from './application/mailbox/mailbox-credentials.ts';
import { MailboxHealthSweep } from './application/mailbox/mailbox-health.ts';
import { MailboxLifecycle } from './application/mailbox/mailbox-lifecycle.ts';
import { MailboxOAuth } from './application/mailbox/mailbox-oauth.ts';
import { MailboxesService } from './application/mailbox/mailboxes.service.ts';
import {
  CAPACITY_COUNTERS,
  MAILBOX_LIMITS,
  MAILBOX_PROVIDERS,
  MAILBOX_REPOSITORY,
  type MailboxLimits,
  type MailboxProvider,
  OAUTH_ATTEMPTS,
  OAUTH_CLIENTS,
  OAUTH_SETTINGS,
  type OAuthClient,
  type OAuthSettings,
  REFRESH_LOCK,
  RUN_LOCK,
  SMTP_CONNECTION_TESTER,
} from './application/mailbox/ports.ts';
import { TokenRefresher } from './application/mailbox/token-refresher.ts';
import { ManualContactLogs } from './application/outbound/manual-log.ts';
import { OutboundCommands } from './application/outbound/outbound.commands.ts';
import { OutboundQueries } from './application/outbound/outbound.queries.ts';
import { OutboundSubscribers } from './application/outbound/outbound.subscribers.ts';
import {
  OUTBOUND_REPOSITORY,
  OUTBOUND_SETTINGS,
  OUTREACH_TOKENS,
  type OutboundSettings,
} from './application/outbound/ports.ts';
import { DrizzleDraftContext } from './infrastructure/drafting/drizzle-draft-context.ts';
import { DrizzleDraftRepository } from './infrastructure/drafting/drizzle-drafts.repository.ts';
import { DrizzleTemplateRepository } from './infrastructure/drafting/drizzle-templates.repository.ts';
import { DrizzleMailboxesRepository } from './infrastructure/mailboxes/drizzle-mailboxes.repository.ts';
import { GoogleOAuthClient } from './infrastructure/mailboxes/oauth/google.oauth.ts';
import { MicrosoftOAuthClient } from './infrastructure/mailboxes/oauth/microsoft.oauth.ts';
import { GmailProvider } from './infrastructure/mailboxes/providers/gmail.provider.ts';
import { GraphProvider } from './infrastructure/mailboxes/providers/graph.provider.ts';
import { SmtpImapProvider } from './infrastructure/mailboxes/providers/smtp-imap.provider.ts';
import { ValkeyCapacityCounters } from './infrastructure/mailboxes/valkey-capacity-counters.ts';
import { ValkeyOAuthStore } from './infrastructure/mailboxes/valkey-oauth.ts';
import { DrizzleOutboundRepository } from './infrastructure/outbound/drizzle-outbound.repository.ts';
import { HmacOutreachTokens } from './infrastructure/outbound/hmac-outreach-tokens.ts';
import { OutboundPersonalData } from './infrastructure/outbound/outbound-personal-data.ts';
import { OutboundSender } from './infrastructure/sending/outbound-sender.ts';
import {
  OUTREACH_TICK_AUTOSTART,
  OutreachSendProcessor,
  OutreachTickProcessor,
  OutreachTickScheduler,
} from './infrastructure/sending/outreach-processors.ts';
import { DraftsController } from './interface/http/drafts.controller.ts';
import { MailboxOAuthController } from './interface/http/mailbox-oauth.controller.ts';
import { MailboxesController } from './interface/http/mailboxes.controller.ts';
import { MessagesController } from './interface/http/messages.controller.ts';
import { TemplatesController } from './interface/http/templates.controller.ts';

const callbackUrl = (env: ApiEnv, provider: 'google' | 'microsoft') =>
  `${env.API_URL.replace(/\/$/, '')}/v1/mailboxes/oauth/${provider}/callback`;

const instances = new Map<AppMode, DynamicModule>();

/**
 * Outreach (ARCHITECTURE §12). BF-050: mailboxes — providers behind one port, the lifecycle, capacity with an
 * atomic reservation, sending windows, rotation, and the hourly health sweep (worker). BF-051: templates and
 * drafts. BF-052: the outbound pipeline — one-click send, the minute tick and the send worker (worker only).
 */
@Module({})
export class OutreachModule {
  static forRoot(mode: AppMode): DynamicModule {
    const existing = instances.get(mode);
    if (existing) return existing;
    const module: DynamicModule = {
      module: OutreachModule,
      imports: [
        RealtimeModule.forRoot(mode),
        ComplianceModule.forRoot(mode),
        GenerationModule.forRoot(mode),
        CrmModule.forRoot(mode),
      ],
      controllers:
        mode === 'worker'
          ? []
          : [
              MailboxesController,
              MailboxOAuthController,
              TemplatesController,
              DraftsController,
              MessagesController,
            ],
      providers: [
        { provide: MAILBOX_REPOSITORY, useClass: DrizzleMailboxesRepository },
        ValkeyCapacityCounters,
        { provide: CAPACITY_COUNTERS, useExisting: ValkeyCapacityCounters },
        { provide: RUN_LOCK, useExisting: ValkeyCapacityCounters },
        SmtpImapProvider,
        GmailProvider,
        GraphProvider,
        { provide: SMTP_CONNECTION_TESTER, useExisting: SmtpImapProvider },
        {
          provide: MAILBOX_PROVIDERS,
          inject: [SmtpImapProvider, GmailProvider, GraphProvider],
          useFactory: (...providers: MailboxProvider[]) =>
            new Map(providers.map((provider) => [provider.kind, provider])),
        },
        {
          provide: MAILBOX_LIMITS,
          inject: [APP_ENV],
          useFactory: (appEnv: AppEnv): MailboxLimits => {
            const env = appEnv as ApiEnv;
            return {
              maxDailyCap: {
                gmail: env.MAILBOX_MAX_DAILY_CAP_GMAIL,
                graph: env.MAILBOX_MAX_DAILY_CAP_GRAPH,
                smtp_imap: env.MAILBOX_MAX_DAILY_CAP_SMTP,
              },
              workspaceDailyCap: env.OUTREACH_WORKSPACE_DAILY_CAP,
              domainHourlyLimit: env.OUTREACH_DOMAIN_HOURLY_LIMIT,
              insecureHosts: env.MAILBOX_SMTP_INSECURE_HOSTS,
              production: env.NODE_ENV === 'production',
              seedAddress: env.MAILBOX_HEALTH_SEED_ADDRESS ?? null,
            };
          },
        },
        ValkeyOAuthStore,
        { provide: OAUTH_ATTEMPTS, useExisting: ValkeyOAuthStore },
        { provide: REFRESH_LOCK, useExisting: ValkeyOAuthStore },
        {
          provide: OAUTH_CLIENTS,
          inject: [APP_ENV, CLOCK],
          useFactory: (appEnv: AppEnv, clock: Clock) => {
            const env = appEnv as ApiEnv;
            const now = () => clock.now();
            const clients: OAuthClient[] = [
              new GoogleOAuthClient(
                env.GOOGLE_OAUTH_CLIENT_ID,
                env.GOOGLE_OAUTH_CLIENT_SECRET,
                callbackUrl(env, 'google'),
                now,
              ),
              new MicrosoftOAuthClient(
                env.MICROSOFT_OAUTH_CLIENT_ID,
                env.MICROSOFT_OAUTH_CLIENT_SECRET,
                env.MICROSOFT_OAUTH_TENANT,
                callbackUrl(env, 'microsoft'),
                now,
              ),
            ];
            return new Map(clients.map((client) => [client.provider, client]));
          },
        },
        {
          provide: OAUTH_SETTINGS,
          inject: [APP_ENV],
          useFactory: (appEnv: AppEnv): OAuthSettings => {
            const env = appEnv as ApiEnv;
            return {
              callbackUrl: (provider) => callbackUrl(env, provider),
              returnUrl: `${env.APP_URL.replace(/\/$/, '')}/settings/mailboxes`,
              // One secret to rotate: the state key is derived from the auth secret.
              stateKey: createHmac('sha256', env.BETTER_AUTH_SECRET)
                .update('mailbox-oauth-state')
                .digest('hex'),
            };
          },
        },
        TokenRefresher,
        MailboxOAuth,
        { provide: TEMPLATE_REPOSITORY, useClass: DrizzleTemplateRepository },
        TemplatesService,
        { provide: DRAFT_REPOSITORY, useClass: DrizzleDraftRepository },
        { provide: DRAFT_CONTEXT, useClass: DrizzleDraftContext },
        DraftsService,
        MailboxCredentialStore,
        MailboxLifecycle,
        MailboxesService,
        MailboxCapacity,
        { provide: OUTBOUND_REPOSITORY, useClass: DrizzleOutboundRepository },
        {
          provide: OUTREACH_TOKENS,
          inject: [APP_ENV],
          useFactory: (appEnv: AppEnv) =>
            new HmacOutreachTokens(
              createHmac('sha256', (appEnv as ApiEnv).BETTER_AUTH_SECRET)
                .update('outreach-token')
                .digest('hex'),
            ),
        },
        {
          provide: OUTBOUND_SETTINGS,
          inject: [APP_ENV],
          useFactory: (appEnv: AppEnv): OutboundSettings => ({
            undoWindowSeconds: (appEnv as ApiEnv).OUTREACH_UNDO_WINDOW_SECONDS,
          }),
        },
        OutboundCommands,
        OutboundQueries,
        ManualContactLogs,
        OutboundPersonalData,
        OutboundSubscribers,
        ...(mode === 'worker'
          ? [
              MailboxHealthSweep,
              OutboundSender,
              OutreachTickProcessor,
              OutreachSendProcessor,
              OutreachTickScheduler,
              { provide: OUTREACH_TICK_AUTOSTART, useValue: true },
            ]
          : []),
      ],
      exports: [
        MailboxCapacity,
        MailboxesService,
        MAILBOX_REPOSITORY,
        MAILBOX_PROVIDERS,
        DraftsService,
        TemplatesService,
      ],
    };
    instances.set(mode, module);
    return module;
  }
}
