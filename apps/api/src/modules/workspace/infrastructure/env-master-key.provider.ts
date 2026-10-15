import type { ApiEnv } from '@bf/config';
import type { MasterKey, MasterKeyProvider } from '../application/ports.ts';

/**
 * Master keys from the environment: `SECRETS_MASTER_KEY` is version `SECRETS_MASTER_KEY_VERSION`; during a rotation
 * `SECRETS_MASTER_KEY_PREVIOUS` still opens rows wrapped by the version before (docs/runbooks/secrets-rotation.md).
 */
export class EnvMasterKeyProvider implements MasterKeyProvider {
  private readonly keys = new Map<number, Buffer>();
  private readonly currentVersion: number;

  constructor(
    env: Pick<ApiEnv, 'SECRETS_MASTER_KEY' | 'SECRETS_MASTER_KEY_VERSION' | 'SECRETS_MASTER_KEY_PREVIOUS'>,
  ) {
    this.currentVersion = env.SECRETS_MASTER_KEY_VERSION;
    this.keys.set(this.currentVersion, Buffer.from(env.SECRETS_MASTER_KEY, 'base64'));
    if (env.SECRETS_MASTER_KEY_PREVIOUS) {
      if (this.currentVersion === 1) {
        throw new Error(
          'SECRETS_MASTER_KEY_PREVIOUS needs SECRETS_MASTER_KEY_VERSION ≥ 2 (it is version − 1)',
        );
      }
      const previous = Buffer.from(env.SECRETS_MASTER_KEY_PREVIOUS, 'base64');
      if (previous.equals(this.keys.get(this.currentVersion) as Buffer)) {
        throw new Error('SECRETS_MASTER_KEY_PREVIOUS must differ from SECRETS_MASTER_KEY');
      }
      this.keys.set(this.currentVersion - 1, previous);
    }
  }

  current(): MasterKey {
    return { version: this.currentVersion, key: this.keys.get(this.currentVersion) as Buffer };
  }

  get(version: number): Buffer | undefined {
    return this.keys.get(version);
  }
}
