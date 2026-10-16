import { describe, expect, it } from 'vitest';
import { EnvMasterKeyProvider } from './env-master-key.provider.ts';

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');

describe('EnvMasterKeyProvider', () => {
  it('serves the current key under its version', () => {
    const provider = new EnvMasterKeyProvider({ SECRETS_MASTER_KEY: key(1), SECRETS_MASTER_KEY_VERSION: 1 });
    expect(provider.current()).toEqual({ version: 1, key: Buffer.alloc(32, 1) });
    expect(provider.get(1)).toEqual(Buffer.alloc(32, 1));
    expect(provider.get(0)).toBeUndefined();
  });

  it('keeps the previous key as version − 1 while rotating', () => {
    const provider = new EnvMasterKeyProvider({
      SECRETS_MASTER_KEY: key(2),
      SECRETS_MASTER_KEY_VERSION: 2,
      SECRETS_MASTER_KEY_PREVIOUS: key(1),
    });
    expect(provider.current().version).toBe(2);
    expect(provider.get(1)).toEqual(Buffer.alloc(32, 1));
  });

  it('refuses inconsistent rotation settings', () => {
    expect(
      () =>
        new EnvMasterKeyProvider({
          SECRETS_MASTER_KEY: key(2),
          SECRETS_MASTER_KEY_VERSION: 1,
          SECRETS_MASTER_KEY_PREVIOUS: key(1),
        }),
    ).toThrow(/VERSION ≥ 2/);
    expect(
      () =>
        new EnvMasterKeyProvider({
          SECRETS_MASTER_KEY: key(2),
          SECRETS_MASTER_KEY_VERSION: 2,
          SECRETS_MASTER_KEY_PREVIOUS: key(2),
        }),
    ).toThrow(/must differ/);
  });
});
