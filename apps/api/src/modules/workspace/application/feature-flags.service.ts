import type { FeatureFlag } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { featureState } from '../domain/feature-flags.ts';
import {
  DEPLOYMENT_ENV,
  type DeploymentEnv,
  ORG_SETTINGS_REPOSITORY,
  type OrgSettingsRepository,
} from './ports.ts';

/** Is a product feature on for a workspace? Both the deployment switch and the workspace flag must allow it. */
@Injectable()
export class FeatureFlagService {
  constructor(
    @Inject(ORG_SETTINGS_REPOSITORY) private readonly settings: OrgSettingsRepository,
    @Inject(DEPLOYMENT_ENV) private readonly env: DeploymentEnv,
  ) {}

  async isEnabled(organizationId: string, flag: FeatureFlag): Promise<boolean> {
    const stored = (await this.settings.find(organizationId))?.features ?? {};
    return featureState(flag, stored, this.env).enabled;
  }
}
