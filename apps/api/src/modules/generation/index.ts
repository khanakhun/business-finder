// Public surface of the generation module: other modules import only from here.
export { FactRegistryService } from './application/facts.service.ts';
export { GenerationCommands } from './application/generation.commands.ts';
export { GenerationQueries } from './application/generation.queries.ts';
export type {
  AgentEngine,
  EngineRunContext,
  QualityPipeline,
  WorkspacePreparer,
} from './application/ports.ts';
export { SiteFactExtraction } from './application/site-facts.extraction.ts';
export { GenerationModule } from './generation.module.ts';
