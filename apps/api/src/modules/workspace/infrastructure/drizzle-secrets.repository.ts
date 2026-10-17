import { type DbClient, getExecutor } from '@bf/db';
import { secrets } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, ne } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { SecretMetadata, SecretRecord, SecretsRepository, VaultKey } from '../application/ports.ts';

const metadataColumns = {
  name: secrets.name,
  keyVersion: secrets.keyVersion,
  last4: secrets.last4,
  updatedAt: secrets.updatedAt,
  lastUsedAt: secrets.lastUsedAt,
};

const toMetadata = (row: { name: string } & Omit<SecretMetadata, 'name'>): SecretMetadata => ({
  ...row,
  name: row.name as VaultKey,
});

const toRecord = (row: typeof secrets.$inferSelect): SecretRecord => ({
  ...row,
  name: row.name as VaultKey,
});

@Injectable()
export class DrizzleSecretsRepository implements SecretsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async find(organizationId: string, name: VaultKey): Promise<SecretRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(secrets)
      .where(and(eq(secrets.organizationId, organizationId), eq(secrets.name, name)));
    return row ? toRecord(row) : undefined;
  }

  async list(organizationId: string): Promise<SecretMetadata[]> {
    const rows = await getExecutor(this.db)
      .select(metadataColumns)
      .from(secrets)
      .where(eq(secrets.organizationId, organizationId))
      .orderBy(asc(secrets.name));
    return rows.map(toMetadata);
  }

  async upsert(input: Parameters<SecretsRepository['upsert']>[0]): Promise<SecretMetadata> {
    const values = { ...input.sealed, keyVersion: input.keyVersion, last4: input.last4 };
    const [row] = await getExecutor(this.db)
      .insert(secrets)
      .values({
        organizationId: input.organizationId,
        name: input.name,
        createdBy: input.createdBy,
        ...values,
      })
      .onConflictDoUpdate({
        target: [secrets.organizationId, secrets.name],
        set: { ...values, updatedAt: new Date(), lastUsedAt: null },
      })
      .returning(metadataColumns);
    if (!row) throw new Error('secrets upsert returned no row');
    return toMetadata(row);
  }

  async delete(organizationId: string, name: VaultKey): Promise<boolean> {
    const deleted = await getExecutor(this.db)
      .delete(secrets)
      .where(and(eq(secrets.organizationId, organizationId), eq(secrets.name, name)))
      .returning({ id: secrets.id });
    return deleted.length > 0;
  }

  async touch(organizationId: string, name: VaultKey, at: Date): Promise<void> {
    // The root client on purpose: this runs after the caller's transaction may have ended.
    await this.db
      .update(secrets)
      .set({ lastUsedAt: at })
      .where(and(eq(secrets.organizationId, organizationId), eq(secrets.name, name)));
  }

  async listForRotation(currentVersion: number, limit: number, afterId?: string): Promise<SecretRecord[]> {
    const rows = await getExecutor(this.db)
      .select()
      .from(secrets)
      .where(and(ne(secrets.keyVersion, currentVersion), afterId ? gt(secrets.id, afterId) : undefined))
      .orderBy(asc(secrets.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  async rewrap(
    id: string,
    expected: Parameters<SecretsRepository['rewrap']>[1],
    to: Parameters<SecretsRepository['rewrap']>[2],
  ): Promise<boolean> {
    // updated_at stays: rotation does not change the value.
    const updated = await getExecutor(this.db)
      .update(secrets)
      .set(to)
      .where(
        and(
          eq(secrets.id, id),
          eq(secrets.keyVersion, expected.keyVersion),
          eq(secrets.dekIv, expected.dekIv),
        ),
      )
      .returning({ id: secrets.id });
    return updated.length > 0;
  }
}
