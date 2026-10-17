// Public surface of the compliance module: the gate and the suppression check are the only entry points.
export {
  ComplianceService,
  type ComplianceTarget,
  type EvaluateContext,
} from './application/compliance.service.ts';
export { type IssuedUnsubscribe, UnsubscribeService } from './application/unsubscribe.service.ts';
export { ComplianceModule } from './compliance.module.ts';
export { ComplianceEmailSuppression } from './infrastructure/compliance-email-suppression.ts';
