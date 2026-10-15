import {
  type DiscoverySettings,
  type EnrichmentSettings,
  resolveDiscoverySettings,
  resolveEnrichmentSettings,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ORG_SETTINGS_REPOSITORY, type OrgSettingsRepository } from './ports.ts';

/** Workspace defaults other modules need (public surface): location hint, discovery and enrichment choices. */
@Injectable()
export class WorkspaceDefaults {
  constructor(@Inject(ORG_SETTINGS_REPOSITORY) private readonly settings: OrgSettingsRepository) {}

  /** The workspace's default country, else the country of its postal address, else null. */
  async countryHint(organizationId: string): Promise<string | null> {
    const settings = await this.settings.find(organizationId);
    return settings?.defaultCountryCode ?? settings?.postalAddress?.countryCode ?? null;
  }

  /** Discovery choices (provider order, disabled providers, Google field tier, monthly budget) over defaults. */
  async discoverySettings(organizationId: string): Promise<DiscoverySettings> {
    return resolveDiscoverySettings((await this.settings.find(organizationId))?.discovery);
  }

  /** Enrichment choices (monthly budget, nightly refresh cap) over defaults. */
  async enrichmentSettings(organizationId: string): Promise<EnrichmentSettings> {
    return resolveEnrichmentSettings((await this.settings.find(organizationId))?.enrichment);
  }
}
