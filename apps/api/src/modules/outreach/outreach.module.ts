import type { ApiEnv } from '@bf/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { RealtimeModule } from '../realtime/index.ts';
import { MailboxCapacity } from './application/mailbox/mailbox-capacity.ts';
import { MailboxCredentialStore } from './application/mailbox/mailbox-credentials.ts';
import { MailboxHealthSweep } from './application/mailbox/mailbox-health.ts';
import { MailboxLifecycle } from './application/mailbox/mailbox-lifecycle.ts';
import { MailboxesService } from './application/mailbox/mailboxes.service.ts';
import {
  CAPACITY_COUNTERS,
  MAILBOX_LIMITS,
  MAILBOX_PROVIDERS,
  MAILBOX_REPOSITORY,
  type MailboxLimits,
  type MailboxProvider,
  RUN_LOCK,
  SMTP_CONNECTION_TESTER,
} from './application/mailbox/ports.ts';
import { DrizzleMailboxesRepository } from './infrastructure/mailboxes/drizzle-mailboxes.repository.ts';
import { SmtpImapProvider } from './infrastructure/mailboxes/providers/smtp-imap.provider.ts';
import { ValkeyCapacityCounters } from './infrastructure/mailboxes/valkey-capacity-counters.ts';
import { MailboxesController } from './interface/http/mailboxes.controller.ts';

const instances = new Map<AppMode, DynamicModule>();

/**
 * Outreach (ARCHITECTURE §12). BF-050: mailboxes — providers behind one port, the lifecycle, capacity with an
 * atomic reservation, sending windows, rotation, and the hourly health sweep (worker).
 */
@Module({})
export class OutreachModule {
  static forRoot(mode: AppMode): DynamicModule {
    const existing = instances.get(mode);
    if (existing) return existing;
    const module: DynamicModule = {
      module: OutreachModule,
      imports: [RealtimeModule.forRoot(mode)],
      controllers: mode === 'worker' ? [] : [MailboxesController],
      providers: [
        { provide: MAILBOX_REPOSITORY, useClass: DrizzleMailboxesRepository },
        ValkeyCapacityCounters,
        { provide: CAPACITY_COUNTERS, useExisting: ValkeyCapacityCounters },
        { provide: RUN_LOCK, useExisting: ValkeyCapacityCounters },
        SmtpImapProvider,
        { provide: SMTP_CONNECTION_TESTER, useExisting: SmtpImapProvider },
        {
          provide: MAILBOX_PROVIDERS,
          inject: [SmtpImapProvider],
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
        MailboxCredentialStore,
        MailboxLifecycle,
        MailboxesService,
        MailboxCapacity,
        ...(mode === 'worker' ? [MailboxHealthSweep] : []),
      ],
      exports: [MailboxCapacity, MailboxesService, MAILBOX_REPOSITORY, MAILBOX_PROVIDERS],
    };
    instances.set(mode, module);
    return module;
  }
}
