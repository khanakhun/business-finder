// Public surface of the compliance module: the gate and the suppression check are the only entry points.
export {
  ComplianceService,
  type ComplianceTarget,
  type EvaluateContext,
} from './application/compliance.service.ts';
export { DsrService } from './application/dsr.service.ts';
export {
  type DataSubjectQuery,
  type ErasureResult,
  type ExportChunk,
  type PersonalDataProvider,
  type PersonalDataRecordRef,
  PersonalDataRegistry,
} from './application/personal-data.ts';
export { type RetentionPolicy, RetentionRegistry } from './application/retention.ts';
export { type IssuedUnsubscribe, UnsubscribeService } from './application/unsubscribe.service.ts';
export { ComplianceModule } from './compliance.module.ts';
export { ComplianceEmailSuppression } from './infrastructure/compliance-email-suppression.ts';
