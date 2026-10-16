// Public surface of the enrichment module: other modules register steps through `StepRegistry`.
export { EnrichmentPlanning } from './application/enrichment.use-cases.ts';
export {
  NightlyMaintenance,
  type NightlyMaintenanceTask,
  StepRegistry,
} from './application/step-registry.ts';
export type {
  EnrichmentStep,
  EnrichmentSubject,
  StepExecution,
  StepOutput,
  StepResult,
} from './domain/enrichment-step.ts';
export { StepDeferredError, StepInterruptedError } from './domain/enrichment-step.ts';
export { EnrichmentModule } from './enrichment.module.ts';
