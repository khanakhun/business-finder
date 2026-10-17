import { createHmac } from 'node:crypto';
import type { ApiEnv } from '@bf/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { CompliancePolicies } from './application/compliance.policies.ts';
import { ComplianceService } from './application/compliance.service.ts';
import { ComplianceSubscribers } from './application/compliance.subscribers.ts';
import {
  COMPLIANCE_INPUTS,
  COMPLIANCE_TELEMETRY,
  DECISION_REPOSITORY,
  LAWFUL_BASIS_REPOSITORY,
  POLICY_REPOSITORY,
  RECIPIENT_TYPE_RESOLVER,
  SUPPRESSION_REPOSITORY,
  UNSUBSCRIBE_SETTINGS,
  UNSUBSCRIBE_TOKEN_REPOSITORY,
  type UnsubscribeSettings,
} from './application/ports.ts';
import { SuppressionAdmin } from './application/suppression-admin.ts';
import { UnsubscribeService } from './application/unsubscribe.service.ts';
import { ComplianceEmailSuppression } from './infrastructure/compliance-email-suppression.ts';
import {
  DrizzleDecisionRepository,
  DrizzleLawfulBasisRepository,
  DrizzlePolicyRepository,
  DrizzleSuppressionRepository,
} from './infrastructure/drizzle-compliance.repositories.ts';
import { DrizzleComplianceInputs } from './infrastructure/drizzle-compliance-inputs.ts';
import { DrizzleUnsubscribeTokenRepository } from './infrastructure/drizzle-unsubscribe-tokens.repository.ts';
import { FrRegistryRecipientType } from './infrastructure/fr-registry-recipient-type.ts';
import { PROMETHEUS_COMPLIANCE_TELEMETRY } from './infrastructure/metrics.ts';
import { ComplianceController } from './interface/http/compliance.controller.ts';
import { CompliancePoliciesController } from './interface/http/policies.controller.ts';
import {
  PublicUnsubscribeController,
  UnsubscribePageController,
} from './interface/http/public-unsubscribe.controller.ts';

/**
 * Outreach compliance (BF-049, ADR-0012): the policy engine and its mandatory gate (`ComplianceService.evaluate`),
 * the suppression core and the opt-out subscriber. Sending (BF-052), sequences (BF-053) and calls (BF-057) go through
 * `ComplianceService`; nothing else decides whether a business may be contacted.
 */
@Module({})
export class ComplianceModule {
  private static readonly built = new Map<AppMode, DynamicModule>();

  static forRoot(mode: AppMode): DynamicModule {
    let module = ComplianceModule.built.get(mode);
    if (!module) {
      module = {
        module: ComplianceModule,
        controllers:
          mode === 'worker'
            ? []
            : [
                ComplianceController,
                CompliancePoliciesController,
                PublicUnsubscribeController,
                UnsubscribePageController,
              ],
        providers: [
          { provide: POLICY_REPOSITORY, useClass: DrizzlePolicyRepository },
          { provide: DECISION_REPOSITORY, useClass: DrizzleDecisionRepository },
          { provide: SUPPRESSION_REPOSITORY, useClass: DrizzleSuppressionRepository },
          { provide: COMPLIANCE_INPUTS, useClass: DrizzleComplianceInputs },
          { provide: LAWFUL_BASIS_REPOSITORY, useClass: DrizzleLawfulBasisRepository },
          { provide: RECIPIENT_TYPE_RESOLVER, useClass: FrRegistryRecipientType },
          { provide: COMPLIANCE_TELEMETRY, useValue: PROMETHEUS_COMPLIANCE_TELEMETRY },
          { provide: UNSUBSCRIBE_TOKEN_REPOSITORY, useClass: DrizzleUnsubscribeTokenRepository },
          {
            provide: UNSUBSCRIBE_SETTINGS,
            inject: [APP_ENV],
            useFactory: (appEnv: AppEnv): UnsubscribeSettings => {
              const env = appEnv as ApiEnv;
              return {
                baseUrl: (env.UNSUBSCRIBE_BASE_URL ?? env.API_URL).replace(/\/$/, ''),
                pepper:
                  env.PRIVACY_HASH_PEPPER ??
                  createHmac('sha256', env.BETTER_AUTH_SECRET).update('privacy-hash-pepper').digest('hex'),
              };
            },
          },
          UnsubscribeService,
          SuppressionAdmin,
          CompliancePolicies,
          ComplianceService,
          ComplianceSubscribers,
          ComplianceEmailSuppression,
        ],
        exports: [ComplianceService, ComplianceEmailSuppression, UnsubscribeService],
      };
      ComplianceModule.built.set(mode, module);
    }
    return module;
  }
}
