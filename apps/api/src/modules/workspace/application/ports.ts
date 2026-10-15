import type {
  AuditActorType,
  AuditLogQuery,
  FeatureFlags,
  Locale,
  PostalAddress,
  SecretName,
  SenderDefaults,
} from '@bf/contracts';
import type { SealedSecret } from '../../platform/crypto/envelope.ts';

export interface OrgSettingsRecord {
  readonly organizationId: string;
  readonly agencyName: string | null;
  readonly legalName: string | null;
  readonly postalAddress: PostalAddress | null;
  readonly websiteUrl: string | null;
  readonly logoAssetKey: string | null;
  readonly logoContentType: string | null;
  readonly primaryLocale: Locale;
  readonly locales: readonly Locale[];
  readonly timezone: string;
  readonly senderDefaults: SenderDefaults;
  readonly features: FeatureFlags;
  readonly updatedAt: Date | null;
}

export type OrgSettingsPatch = Partial<Omit<OrgSettingsRecord, 'organizationId' | 'updatedAt'>>;

/** Port: `org_settings`. `find` returns defaults-free data; callers apply defaults. */
export interface OrgSettingsRepository {
  find(organizationId: string): Promise<OrgSettingsRecord | undefined>;
  upsert(
    organizationId: string,
    patch: OrgSettingsPatch,
    updatedBy: string | null,
  ): Promise<OrgSettingsRecord>;
}
export const ORG_SETTINGS_REPOSITORY = Symbol('OrgSettingsRepository');

export interface SecretMetadata {
  readonly name: SecretName;
  readonly keyVersion: number;
  readonly last4: string | null;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date | null;
}

export interface SecretRecord extends SecretMetadata, SealedSecret {
  readonly id: string;
  readonly organizationId: string;
}

/** Port: `secrets`. Every method is scoped by organization except the rotation scan. */
export interface SecretsRepository {
  find(organizationId: string, name: SecretName): Promise<SecretRecord | undefined>;
  list(organizationId: string): Promise<SecretMetadata[]>;
  upsert(input: {
    readonly organizationId: string;
    readonly name: SecretName;
    readonly sealed: SealedSecret;
    readonly keyVersion: number;
    readonly last4: string | null;
    readonly createdBy: string | null;
  }): Promise<SecretMetadata>;
  delete(organizationId: string, name: SecretName): Promise<boolean>;
  /** Outside any ambient transaction: called fire-and-forget after reads. */
  touch(organizationId: string, name: SecretName, at: Date): Promise<void>;
  /** Rows wrapped by another master key version, oldest id first, after `afterId`. */
  listForRotation(currentVersion: number, limit: number, afterId?: string): Promise<SecretRecord[]>;
  /**
   * Compare-and-set on the version **and** the data key nonce read (`expectedDekIv`, random per seal): a secret
   * replaced meanwhile (e.g. by an instance still on the old key) is left alone instead of being corrupted.
   */
  rewrap(
    id: string,
    expected: { readonly keyVersion: number; readonly dekIv: Buffer },
    to: {
      readonly keyVersion: number;
      readonly wrappedDek: Buffer;
      readonly dekIv: Buffer;
      readonly dekTag: Buffer;
    },
  ): Promise<boolean>;
}
export const SECRETS_REPOSITORY = Symbol('SecretsRepository');

export interface MasterKey {
  readonly version: number;
  readonly key: Buffer;
}

/** Port (Strategy): where master keys come from. `EnvMasterKeyProvider` today, a KMS adapter later. */
export interface MasterKeyProvider {
  current(): MasterKey;
  get(version: number): Buffer | undefined;
}
export const MASTER_KEY_PROVIDER = Symbol('MasterKeyProvider');

export interface NewAuditEntry {
  readonly organizationId: string | null;
  readonly actorType: AuditActorType;
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly metadata: Record<string, unknown>;
  readonly occurredAt: Date;
}

export interface AuditEntryRecord extends NewAuditEntry {
  readonly id: string;
}

export interface AuditLogFilter extends Omit<AuditLogQuery, 'limit' | 'cursor'> {
  readonly organizationId: string;
  /** Strictly older than this position (cursor). */
  readonly before?: { readonly occurredAt: Date; readonly id: string };
  readonly limit: number;
}

/** Port: `audit_logs` (append-only: there is deliberately no update or delete). */
export interface AuditLogRepository {
  insert(entry: NewAuditEntry): Promise<void>;
  list(filter: AuditLogFilter): Promise<AuditEntryRecord[]>;
}
export const AUDIT_LOG_REPOSITORY = Symbol('AuditLogRepository');

/** Deployment env values the workspace module reads (feature switches, global provider keys). */
export const DEPLOYMENT_ENV = Symbol('DeploymentEnv');
export type DeploymentEnv = Readonly<Record<string, unknown>>;
