import { type SecretName, secretDefinition } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { DEPLOYMENT_ENV, type DeploymentEnv } from './ports.ts';
import { SecretsVault } from './secrets-vault.ts';

export interface ResolvedSecret {
  readonly value: string;
  readonly source: 'workspace' | 'global';
}

/**
 * The value a feature should use: the workspace's own secret, else the deployment-wide env value when the
 * registry allows a fallback. Never logs values.
 */
@Injectable()
export class SecretResolver {
  constructor(
    private readonly vault: SecretsVault,
    @Inject(DEPLOYMENT_ENV) private readonly env: DeploymentEnv,
  ) {}

  /** `organizationId` null (platform work, evals): only the deployment value is considered. */
  async resolve(organizationId: string | null, name: SecretName): Promise<ResolvedSecret | undefined> {
    const own = organizationId ? await this.vault.get(organizationId, name) : undefined;
    if (own !== undefined) return { value: own, source: 'workspace' };
    const global = this.globalValue(name);
    return global === undefined ? undefined : { value: global, source: 'global' };
  }

  /** Whether a deployment-wide value exists for `name` (and may be used). */
  hasGlobal(name: SecretName): boolean {
    return this.globalValue(name) !== undefined;
  }

  private globalValue(name: SecretName): string | undefined {
    const definition = secretDefinition(name);
    if (!definition.allowGlobalFallback || !definition.globalEnv) return undefined;
    const value = this.env[definition.globalEnv];
    return typeof value === 'string' && value !== '' ? value : undefined;
  }
}
