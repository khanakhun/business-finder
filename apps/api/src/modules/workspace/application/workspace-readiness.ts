import type { OutreachReadiness } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { outreachReadiness } from '../domain/readiness.ts';
import { ORG_SETTINGS_REPOSITORY, type OrgSettingsRepository } from './ports.ts';

/** Readiness checks other modules call before acting for a workspace (M4 outreach: compliance §2). */
@Injectable()
export class WorkspaceReadiness {
  constructor(@Inject(ORG_SETTINGS_REPOSITORY) private readonly settings: OrgSettingsRepository) {}

  async forOutreach(organizationId: string): Promise<OutreachReadiness> {
    const row = await this.settings.find(organizationId);
    return outreachReadiness({
      agencyName: row?.agencyName ?? null,
      postalAddress: row?.postalAddress ?? null,
    });
  }
}
