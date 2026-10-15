// Public surface of the business-graph module: other modules import only from here.
export {
  BUSINESS_REPOSITORY,
  type BusinessRepository,
  ORG_BUSINESS_REPOSITORY,
  type OrgBusinessRepository,
  SOURCE_RECORD_REPOSITORY,
  type SourceRecordRepository,
} from './application/ports.ts';
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
