import { createHmac } from 'node:crypto';
import type { ApiEnv } from '@bf/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { ComplianceModule } from '../compliance/index.ts';
import { CrmModule } from '../crm/index.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { RealtimeModule } from '../realtime/index.ts';
import { SitesModule } from '../sites/index.ts';
import { LeadAutomation } from './application/lead-automation.ts';
import { LeadsInbox } from './application/leads.inbox.ts';
import { LEADS_RETENTION } from './application/leads.retention.ts';
import { LEAD_GUARD, LEAD_TOKEN_SECRET, LEADS_REPOSITORY, PROOF_OF_WORK } from './application/ports.ts';
import { PublicDsrIntake } from './application/public-dsr-intake.ts';
import { PublicLeads } from './application/public-leads.ts';
import { UnsubscribeEffects } from './application/unsubscribe-effects.ts';
import { AltchaProofOfWork } from './infrastructure/altcha-proof-of-work.ts';
import { DrizzleLeadsRepository } from './infrastructure/drizzle-leads.repository.ts';
import { LeadPersonalData } from './infrastructure/lead-personal-data.ts';
import { ValkeyLeadGuard } from './infrastructure/valkey-lead-guard.ts';
import { LeadsController } from './interface/http/leads.controller.ts';
import { PublicDsrController } from './interface/http/public-dsr.controller.ts';
import { LEAD_SITES_DOMAIN, PublicLeadsController } from './interface/http/public-leads.controller.ts';

const derive = (secret: string, label: string) => createHmac('sha256', secret).update(label).digest('hex');

/**
 * Leads from preview sites (BF-048): the renderer's anonymous claim, contact and opt-out forms (proof of work,
 * anti-spam, no IP stored), the CRM automation they start, and the leads inbox.
 */
@Module({})
export class LeadsModule {
  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: LeadsModule,
      imports: [
        SitesModule.forRoot(mode),
        CrmModule.forRoot(mode),
        RealtimeModule.forRoot(mode),
        ComplianceModule.forRoot(mode),
      ],
      controllers: mode === 'worker' ? [] : [PublicLeadsController, PublicDsrController, LeadsController],
      providers: [
        { provide: LEADS_REPOSITORY, useClass: DrizzleLeadsRepository },
        { provide: LEAD_GUARD, useClass: ValkeyLeadGuard },
        {
          // The renderer's shared secret (BF-036): unset, lead capture is off (like view counting).
          provide: LEAD_TOKEN_SECRET,
          inject: [APP_ENV],
          useFactory: (env: AppEnv) => (env as ApiEnv).SITES_VIEW_TOKEN_SECRET ?? null,
        },
        {
          // Proof-of-work keys derived from that secret (one secret to rotate).
          provide: PROOF_OF_WORK,
          inject: [APP_ENV],
          useFactory: (env: AppEnv) => {
            const secret = (env as ApiEnv).SITES_VIEW_TOKEN_SECRET ?? 'lead-capture-disabled';
            return new AltchaProofOfWork(derive(secret, 'altcha:signature'), derive(secret, 'altcha:key'));
          },
        },
        {
          provide: LEAD_SITES_DOMAIN,
          inject: [APP_ENV],
          useFactory: (env: AppEnv) => (env as ApiEnv).SITES_BASE_DOMAIN,
        },
        {
          provide: LEADS_RETENTION,
          inject: [APP_ENV],
          useFactory: (env: AppEnv) => ({
            leads: (env as ApiEnv).LEADS_RETENTION_DAYS,
            spam: (env as ApiEnv).LEADS_SPAM_RETENTION_DAYS,
          }),
        },
        PublicLeads,
        LeadsInbox,
        LeadAutomation,
        UnsubscribeEffects,
        LeadPersonalData,
        PublicDsrIntake,
      ],
    };
  }
}
