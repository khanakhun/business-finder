// Public surface of the enrichment module: other modules register steps through `StepRegistry`.
export { StepRegistry } from './application/step-registry.ts';
export type {
  EnrichmentStep,
  EnrichmentSubject,
  StepExecution,
  StepOutput,
  StepResult,
} from './domain/enrichment-step.ts';
export { EnrichmentModule } from './enrichment.module.ts';
