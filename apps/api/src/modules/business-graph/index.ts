// Public surface of the business-graph module: other modules import only from here.

export {
  ReplaceWebsiteMediaCommand,
  type WebsiteMediaItem,
} from './application/media/replace-website-media.command.ts';
export {
  BUSINESS_REPOSITORY,
  type BusinessRepository,
  ORG_BUSINESS_REPOSITORY,
  type OrgBusinessRepository,
  SOURCE_RECORD_REPOSITORY,
  type SourceRecordRepository,
} from './application/ports.ts';
export {
  IngestBatchCommand,
  type IngestBatchCounts,
  type IngestBatchResult,
} from './application/resolution/ingest-batch.command.ts';
export {
  type IngestOptions,
  type IngestResult,
  IngestSourceRecordCommand,
} from './application/resolution/ingest-source-record.command.ts';
export {
  type CategoryCandidate,
  CategoryCandidateSearch,
} from './application/taxonomy/category-candidates.ts';
export {
  type CategoryClassification,
  CategoryClassifier,
  type ClassifyInput,
  type ProviderCategory,
} from './application/taxonomy/category-classifier.ts';
export { BusinessGraphModule } from './business-graph.module.ts';
