import { type DiscoverySettings, resolveDiscoverySettings } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ORG_SETTINGS_REPOSITORY, type OrgSettingsRepository } from './ports.ts';

/** Workspace defaults other modules need (public surface): location hint, discovery choices. */
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
}
