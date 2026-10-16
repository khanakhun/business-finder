// Public surface of the discovery module (BF-018): runs (BF-020) plan with these.
export {
  ProviderCostEstimator,
  ProviderQueryBuilder,
  ProviderSelectionService,
} from './application/discovery.services.ts';
export { ProviderRegistry } from './application/provider-registry.ts';
export { ScraperAcknowledgement } from './application/scraper-acknowledgement.ts';
export { DiscoveryModule } from './discovery.module.ts';
export type { DiscoveryProvider, ProviderFetchResult } from './domain/provider.port.ts';
// The scraper's CSV and download helpers, for review mining's on-demand jobs (BF-029).
export { csvObjects } from './infrastructure/providers/maps-scraper/csv.ts';
export { readCapped } from './infrastructure/providers/maps-scraper/provider.ts';
