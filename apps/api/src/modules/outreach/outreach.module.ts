import { createHmac } from 'node:crypto';
import type { ApiEnv } from '@bf/config';
import type { Clock } from '@bf/contracts';
import { type DynamicModule, Module } from '@nestjs/common';
import { BusinessGraphModule } from '../business-graph/index.ts';
import { ComplianceModule } from '../compliance/index.ts';
import { CrmModule } from '../crm/index.ts';
import { GenerationModule } from '../generation/index.ts';
import { CLOCK } from '../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { RealtimeModule } from '../realtime/index.ts';
import { SitesModule } from '../sites/index.ts';
import { DeliverabilityService, DNS_LOOKUPS } from './application/deliverability/deliverability.service.ts';
import { DeliverabilityDigest } from './application/deliverability/digest.ts';
import { DeliverabilityHealth } from './application/deliverability/health.ts';
import { KillSwitchService } from './application/deliverability/kill-switch.ts';
import { DELIVERABILITY_REPOSITORY, MAILBOX_READINESS } from './application/deliverability/ports.ts';
import { DraftsService } from './application/drafting/drafts.service.ts';
import { DRAFT_CONTEXT, DRAFT_REPOSITORY, TEMPLATE_REPOSITORY } from './application/drafting/ports.ts';
import { TemplatesService } from './application/drafting/templates.service.ts';
import { InboxService } from './application/inbound/inbox.ts';
import { ReplyIngestion } from './application/inbound/ingest.ts';
import {
  HTML_SANITIZER,
  INBOUND_QUEUES,
  INBOUND_REPOSITORY,
  INBOUND_SETTINGS,
  type InboundSettings,
  MAIL_PARSER,
} from './application/inbound/ports.ts';
import { ReplyActions } from './application/inbound/reply-actions.ts';
import { MailboxSync } from './application/inbound/sync.ts';
import { ReplyTriageService } from './application/inbound/triage.ts';
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
import { BulkOutreach } from './application/outbound/bulk.ts';
import { ManualContactLogs } from './application/outbound/manual-log.ts';
import { OutboundCommands } from './application/outbound/outbound.commands.ts';
import { OutboundQueries } from './application/outbound/outbound.queries.ts';
import { OutboundSubscribers } from './application/outbound/outbound.subscribers.ts';
import {
  BULK_QUEUE,
  BULK_REPOSITORY,
  OUTBOUND_REPOSITORY,
  OUTBOUND_SETTINGS,
  OUTREACH_TOKENS,
  type OutboundSettings,
} from './application/outbound/ports.ts';
import { EnrollmentsService } from './application/sequences/enrollments.service.ts';
import { SequenceExecutor } from './application/sequences/executor.ts';
import { SEQUENCE_REPOSITORY } from './application/sequences/ports.ts';
import { SequenceSubscribers } from './application/sequences/sequence-subscribers.ts';
import { SequencesService } from './application/sequences/sequences.service.ts';
import { SequenceStatsService } from './application/sequences/stats.ts';
import { DrizzleDeliverabilityRepository } from './infrastructure/deliverability/drizzle-deliverability.repository.ts';
import { DNSBL_KEY, NodeDnsLookups } from './infrastructure/deliverability/node-dns.ts';
import { DrizzleDraftContext } from './infrastructure/drafting/drizzle-draft-context.ts';
import { DrizzleDraftRepository } from './infrastructure/drafting/drizzle-drafts.repository.ts';
import { DrizzleTemplateRepository } from './infrastructure/drafting/drizzle-templates.repository.ts';
import {
  BullmqInboundQueues,
  OPENAPI_INBOUND_QUEUES,
} from './infrastructure/inbound/bullmq-inbound-queues.ts';
import { DrizzleInboundRepository } from './infrastructure/inbound/drizzle-inbound.repository.ts';
import { SanitizeHtmlSanitizer } from './infrastructure/inbound/html-sanitizer.ts';
import { InboundPersonalData } from './infrastructure/inbound/inbound-personal-data.ts';
import { MailparserAdapter } from './infrastructure/inbound/mail-parser.ts';
import { DrizzleMailboxesRepository } from './infrastructure/mailboxes/drizzle-mailboxes.repository.ts';
import { GoogleOAuthClient } from './infrastructure/mailboxes/oauth/google.oauth.ts';
import { MicrosoftOAuthClient } from './infrastructure/mailboxes/oauth/microsoft.oauth.ts';
import { GmailProvider } from './infrastructure/mailboxes/providers/gmail.provider.ts';
import { GraphProvider } from './infrastructure/mailboxes/providers/graph.provider.ts';
import { SmtpImapProvider } from './infrastructure/mailboxes/providers/smtp-imap.provider.ts';
import { ValkeyCapacityCounters } from './infrastructure/mailboxes/valkey-capacity-counters.ts';
import { ValkeyOAuthStore } from './infrastructure/mailboxes/valkey-oauth.ts';
import { BullmqBulkQueue, OPENAPI_BULK_QUEUE } from './infrastructure/outbound/bullmq-bulk-queue.ts';
import { DrizzleBulkRepository } from './infrastructure/outbound/drizzle-bulk.repository.ts';
import { DrizzleOutboundRepository } from './infrastructure/outbound/drizzle-outbound.repository.ts';
import { HmacOutreachTokens } from './infrastructure/outbound/hmac-outreach-tokens.ts';
import { OutboundPersonalData } from './infrastructure/outbound/outbound-personal-data.ts';
import { OutboundSender } from './infrastructure/sending/outbound-sender.ts';
import {
  OUTREACH_TICK_AUTOSTART,
  OutreachBulkProcessor,
  OutreachSendProcessor,
  OutreachSequenceProcessor,
  OutreachSyncProcessor,
  OutreachTickProcessor,
  OutreachTickScheduler,
  OutreachTriageProcessor,
} from './infrastructure/sending/outreach-processors.ts';
import { DrizzleSequencesRepository } from './infrastructure/sequences/drizzle-sequences.repository.ts';
import { OutboundViewAttribution } from './infrastructure/sequences/outbound-view-attribution.ts';
import { BulkController } from './interface/http/bulk.controller.ts';
import { DeliverabilityController } from './interface/http/deliverability.controller.ts';
import { DraftsController } from './interface/http/drafts.controller.ts';
import { InboxController } from './interface/http/inbox.controller.ts';
import { MailboxOAuthController } from './interface/http/mailbox-oauth.controller.ts';
import { MailboxesController } from './interface/http/mailboxes.controller.ts';
import { MessagesController } from './interface/http/messages.controller.ts';
import { SequencesController } from './interface/http/sequences.controller.ts';
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
        BusinessGraphModule.forRoot(mode),
        SitesModule.forRoot(mode),
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
              BulkController,
              InboxController,
              SequencesController,
              DeliverabilityController,
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
        // BF-056: deliverability (the readiness gate the selector and the send path consult).
        { provide: DELIVERABILITY_REPOSITORY, useClass: DrizzleDeliverabilityRepository },
        {
          provide: DNSBL_KEY,
          inject: [APP_ENV],
          useFactory: (appEnv: AppEnv) => (appEnv as ApiEnv).SPAMHAUS_DQS_KEY ?? null,
        },
        { provide: DNS_LOOKUPS, useClass: NodeDnsLookups },
        DeliverabilityService,
        DeliverabilityHealth,
        KillSwitchService,
        DeliverabilityDigest,
        { provide: MAILBOX_READINESS, useExisting: DeliverabilityService },
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
        { provide: BULK_REPOSITORY, useClass: DrizzleBulkRepository },
        mode === 'openapi'
          ? { provide: BULK_QUEUE, useValue: OPENAPI_BULK_QUEUE }
          : { provide: BULK_QUEUE, useClass: BullmqBulkQueue },
        BulkOutreach,
        // BF-054: replies.
        { provide: INBOUND_REPOSITORY, useClass: DrizzleInboundRepository },
        { provide: MAIL_PARSER, useClass: MailparserAdapter },
        { provide: HTML_SANITIZER, useClass: SanitizeHtmlSanitizer },
        mode === 'openapi'
          ? { provide: INBOUND_QUEUES, useValue: OPENAPI_INBOUND_QUEUES }
          : { provide: INBOUND_QUEUES, useClass: BullmqInboundQueues },
        {
          provide: INBOUND_SETTINGS,
          inject: [APP_ENV],
          useFactory: (appEnv: AppEnv): InboundSettings => ({
            pollSeconds: (appEnv as ApiEnv).OUTREACH_SYNC_POLL_SECONDS,
            unsubscribeMailto: null,
          }),
        },
        ReplyIngestion,
        MailboxSync,
        ReplyTriageService,
        ReplyActions,
        InboxService,
        // BF-053: sequences.
        { provide: SEQUENCE_REPOSITORY, useClass: DrizzleSequencesRepository },
        SequencesService,
        EnrollmentsService,
        SequenceExecutor,
        SequenceSubscribers,
        SequenceStatsService,
        OutboundViewAttribution,
        InboundPersonalData,
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
              OutreachBulkProcessor,
              OutreachSyncProcessor,
              OutreachTriageProcessor,
              OutreachSequenceProcessor,
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
