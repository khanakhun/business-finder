// In-memory adapters for unit-testing workspace use cases (the Drizzle adapters are covered by workspace.int.test.ts).

import type { SecretName } from '@bf/contracts';
import { newId } from '@bf/contracts';
import { DEFAULT_SETTINGS } from './mappers.ts';
import type {
  AuditEntryRecord,
  AuditLogFilter,
  AuditLogRepository,
  MasterKey,
  MasterKeyProvider,
  NewAuditEntry,
  OrgSettingsPatch,
  OrgSettingsRecord,
  OrgSettingsRepository,
  SecretMetadata,
  SecretRecord,
  SecretsRepository,
} from './ports.ts';

export class InMemoryOrgSettings implements OrgSettingsRepository {
  rows = new Map<string, OrgSettingsRecord>();

  async find(organizationId: string) {
    return this.rows.get(organizationId);
  }

  async upsert(organizationId: string, patch: OrgSettingsPatch) {
    const row: OrgSettingsRecord = {
      ...DEFAULT_SETTINGS,
      ...this.rows.get(organizationId),
      ...patch,
      organizationId,
      updatedAt: new Date('2026-10-15T00:00:00Z'),
    };
    this.rows.set(organizationId, row);
    return row;
  }
}

export class InMemorySecrets implements SecretsRepository {
  rows: SecretRecord[] = [];
  touches: Array<{ organizationId: string; name: SecretName; at: Date }> = [];

  async find(organizationId: string, name: SecretName) {
    return this.rows.find((row) => row.organizationId === organizationId && row.name === name);
  }

  async list(organizationId: string): Promise<SecretMetadata[]> {
    return this.rows.filter((row) => row.organizationId === organizationId);
  }

  async upsert(input: Parameters<SecretsRepository['upsert']>[0]) {
    const existing = await this.find(input.organizationId, input.name);
    const row: SecretRecord = {
      id: existing?.id ?? newId(),
      organizationId: input.organizationId,
      name: input.name,
      ...input.sealed,
      keyVersion: input.keyVersion,
      last4: input.last4,
      updatedAt: new Date('2026-10-15T00:00:00Z'),
      lastUsedAt: null,
    };
    this.rows = [...this.rows.filter((r) => r !== existing), row];
    return row;
  }

  async delete(organizationId: string, name: SecretName) {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !(row.organizationId === organizationId && row.name === name));
    return this.rows.length < before;
  }

  async touch(organizationId: string, name: SecretName, at: Date) {
    this.touches.push({ organizationId, name, at });
  }

  async listForRotation(currentVersion: number, limit: number, afterId?: string) {
    return this.rows
      .filter((row) => row.keyVersion !== currentVersion && (!afterId || row.id > afterId))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  async rewrap(
    id: string,
    expected: Parameters<SecretsRepository['rewrap']>[1],
    to: Parameters<SecretsRepository['rewrap']>[2],
  ) {
    const row = this.rows.find(
      (r) => r.id === id && r.keyVersion === expected.keyVersion && r.dekIv.equals(expected.dekIv),
    );
    if (!row) return false;
    this.rows = this.rows.map((r) => (r === row ? { ...r, ...to } : r));
    return true;
  }
}

export class InMemoryAuditLog implements AuditLogRepository {
  entries: AuditEntryRecord[] = [];

  async insert(entry: NewAuditEntry) {
    if (entry.id && this.entries.some((e) => e.id === entry.id)) return;
    this.entries.push({ ...entry, id: entry.id ?? newId() });
  }

  async list(filter: AuditLogFilter) {
    return this.entries
      .filter((e) => e.organizationId === filter.organizationId)
      .filter((e) => !filter.action || e.action.startsWith(filter.action))
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, filter.limit);
  }
}

export class StaticMasterKeys implements MasterKeyProvider {
  constructor(
    private readonly keys: Map<number, Buffer>,
    private readonly currentVersion: number,
  ) {}

  static single(version = 1, fill = 7): StaticMasterKeys {
    return new StaticMasterKeys(new Map([[version, Buffer.alloc(32, fill)]]), version);
  }

  current(): MasterKey {
    return { version: this.currentVersion, key: this.keys.get(this.currentVersion) as Buffer };
  }

  get(version: number) {
    return this.keys.get(version);
  }
}
