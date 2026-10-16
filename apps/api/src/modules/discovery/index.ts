// Public surface of the discovery module (BF-018): runs (BF-020) plan with these.
export {
  ProviderCostEstimator,
  ProviderQueryBuilder,
  ProviderSelectionService,
} from './application/discovery.services.ts';
export { ProviderRegistry } from './application/provider-registry.ts';
export { DiscoveryModule } from './discovery.module.ts';
export type { DiscoveryProvider, ProviderFetchResult } from './domain/provider.port.ts';
