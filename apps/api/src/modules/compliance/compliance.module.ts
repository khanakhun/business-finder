import { type DynamicModule, Module } from '@nestjs/common';
import type { AppMode } from '../platform/config/app-env.ts';
import { ComplianceService } from './application/compliance.service.ts';
import { ComplianceSubscribers } from './application/compliance.subscribers.ts';
import {
  COMPLIANCE_INPUTS,
  DECISION_REPOSITORY,
  POLICY_REPOSITORY,
  SUPPRESSION_REPOSITORY,
} from './application/ports.ts';
import { ComplianceEmailSuppression } from './infrastructure/compliance-email-suppression.ts';
import {
  DrizzleDecisionRepository,
  DrizzlePolicyRepository,
  DrizzleSuppressionRepository,
} from './infrastructure/drizzle-compliance.repositories.ts';
import { DrizzleComplianceInputs } from './infrastructure/drizzle-compliance-inputs.ts';
import { ComplianceController } from './interface/http/compliance.controller.ts';

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
        controllers: mode === 'worker' ? [] : [ComplianceController],
        providers: [
          { provide: POLICY_REPOSITORY, useClass: DrizzlePolicyRepository },
          { provide: DECISION_REPOSITORY, useClass: DrizzleDecisionRepository },
          { provide: SUPPRESSION_REPOSITORY, useClass: DrizzleSuppressionRepository },
          { provide: COMPLIANCE_INPUTS, useClass: DrizzleComplianceInputs },
          ComplianceService,
          ComplianceSubscribers,
          ComplianceEmailSuppression,
        ],
        exports: [ComplianceService, ComplianceEmailSuppression],
      };
      ComplianceModule.built.set(mode, module);
    }
    return module;
  }
}
