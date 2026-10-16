import { Inject, Injectable } from '@nestjs/common';
import { ORG_SETTINGS_REPOSITORY, type OrgSettingsRepository } from './ports.ts';

/** Workspace defaults other modules need (public surface): the country hint for places typed without one. */
@Injectable()
export class WorkspaceDefaults {
  constructor(@Inject(ORG_SETTINGS_REPOSITORY) private readonly settings: OrgSettingsRepository) {}

  /** The workspace's default country, else the country of its postal address, else null. */
  async countryHint(organizationId: string): Promise<string | null> {
    const settings = await this.settings.find(organizationId);
    return settings?.defaultCountryCode ?? settings?.postalAddress?.countryCode ?? null;
  }
}
