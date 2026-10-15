import type { Clock, SecretName } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { DecryptionError, openSecret, sealSecret } from '../../platform/crypto/envelope.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import { SecretUnavailableError } from '../domain/errors.ts';
import { assertSecretFormat, last4Of } from '../domain/secret-values.ts';
import {
  MASTER_KEY_PROVIDER,
  type MasterKeyProvider,
  SECRETS_REPOSITORY,
  type SecretMetadata,
  type SecretsRepository,
} from './ports.ts';

/** How long a decrypted value stays in this process's memory (other instances see updates within this delay). */
export const SECRET_CACHE_TTL_MS = 60_000;
/** `last_used_at` is written at most this often per secret and process. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Workspace secrets vault (security.md §2): envelope-encrypted at rest, decrypted just in time, never logged or
 * returned by the API. Values live in memory for at most `SECRET_CACHE_TTL_MS`.
 */
@Injectable()
export class SecretsVault {
  private readonly cache = new Map<string, { readonly value: string; readonly expiresAt: number }>();
  private readonly touchedAt = new Map<string, number>();

  constructor(
    @Inject(SECRETS_REPOSITORY) private readonly repository: SecretsRepository,
    @Inject(MASTER_KEY_PROVIDER) private readonly masterKeys: MasterKeyProvider,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async put(
    organizationId: string,
    name: SecretName,
    value: string,
    createdBy: string | null,
  ): Promise<SecretMetadata> {
    assertSecretFormat(name, value);
    const { version, key } = this.masterKeys.current();
    const sealed = sealSecret(value, key, { orgId: organizationId, name, keyVersion: version });
    const metadata = await this.repository.upsert({
      organizationId,
      name,
      sealed,
      keyVersion: version,
      last4: last4Of(value),
      createdBy,
    });
    this.cache.delete(cacheKey(organizationId, name));
    return metadata;
  }

  /** The plaintext, or undefined when the workspace has not stored this secret. */
  async get(organizationId: string, name: SecretName): Promise<string | undefined> {
    const now = this.clock.now().getTime();
    const key = cacheKey(organizationId, name);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      this.touch(organizationId, name, now);
      return cached.value;
    }
    const row = await this.repository.find(organizationId, name);
    if (!row) {
      this.cache.delete(key);
      return undefined;
    }
    const masterKey = this.masterKeys.get(row.keyVersion);
    if (!masterKey) throw new SecretUnavailableError(name, 'MASTER_KEY_MISSING');
    let value: string;
    try {
      value = openSecret(row, masterKey, { orgId: organizationId, name, keyVersion: row.keyVersion });
    } catch (error) {
      if (error instanceof DecryptionError) throw new SecretUnavailableError(name, 'DECRYPTION_FAILED');
      throw error;
    }
    this.cache.set(key, { value, expiresAt: now + SECRET_CACHE_TTL_MS });
    this.touch(organizationId, name, now);
    return value;
  }

  async has(organizationId: string, name: SecretName): Promise<boolean> {
    return (await this.repository.find(organizationId, name)) !== undefined;
  }

  list(organizationId: string): Promise<SecretMetadata[]> {
    return this.repository.list(organizationId);
  }

  async delete(organizationId: string, name: SecretName): Promise<boolean> {
    this.cache.delete(cacheKey(organizationId, name));
    return this.repository.delete(organizationId, name);
  }

  private touch(organizationId: string, name: SecretName, now: number): void {
    const key = cacheKey(organizationId, name);
    if ((this.touchedAt.get(key) ?? 0) + TOUCH_INTERVAL_MS > now) return;
    this.touchedAt.set(key, now);
    void this.repository.touch(organizationId, name, new Date(now)).catch((error: unknown) => {
      this.logger.warn({ err: error, secret: name, organizationId }, 'Could not record secret use');
    });
  }
}

const cacheKey = (organizationId: string, name: SecretName) => `${organizationId}|${name}`;
