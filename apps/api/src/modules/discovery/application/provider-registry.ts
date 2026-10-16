import type { ProviderId } from '@bf/contracts';
import type { DiscoveryProvider } from '../domain/provider.port.ts';

/** Registry of the deployment's discovery providers (decorated), by id. Adding one is a registration only. */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, DiscoveryProvider>();

  constructor(providers: readonly DiscoveryProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) throw new Error(`Provider ${provider.id} registered twice`);
      this.providers.set(provider.id, provider);
    }
  }

  get(id: ProviderId): DiscoveryProvider | undefined {
    return this.providers.get(id);
  }

  all(): DiscoveryProvider[] {
    return [...this.providers.values()];
  }
}
