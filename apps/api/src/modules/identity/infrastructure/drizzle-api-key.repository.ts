import { fromStatements } from '@bf/auth';
import { type DbClient, getExecutor } from '@bf/db';
import { apikey } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { ApiKeyRecord, ApiKeyRepository } from '../application/ports.ts';

/** What we keep in the plugin's free-form `metadata` JSON column. */
const MetadataSchema = z
  .object({ createdBy: z.string().optional(), revokedAt: z.string().optional() })
  .catch({});
type Metadata = z.infer<typeof MetadataSchema>;

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const metadataOf = (text: string | null): Metadata => MetadataSchema.parse(parseJson(text) ?? {});
const StatementsSchema = z.record(z.string(), z.array(z.string())).catch({});

function toRecord(row: typeof apikey.$inferSelect): ApiKeyRecord {
  const metadata = metadataOf(row.metadata);
  return {
    id: row.id,
    organizationId: row.referenceId,
    name: row.name ?? '',
    start: row.start,
    permissions: fromStatements(StatementsSchema.parse(parseJson(row.permissions))),
    createdBy: metadata.createdBy ?? null,
    createdAt: row.createdAt,
    lastUsedAt: row.lastRequest,
    expiresAt: row.expiresAt,
    revokedAt: metadata.revokedAt
      ? new Date(metadata.revokedAt)
      : row.enabled === false
        ? row.updatedAt
        : null,
  };
}

/** Organization API keys (Better Auth api-key plugin table), always scoped by the owning organization. */
@Injectable()
export class DrizzleApiKeyRepository implements ApiKeyRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async list(organizationId: string): Promise<ApiKeyRecord[]> {
    const rows = await getExecutor(this.db)
      .select()
      .from(apikey)
      .where(eq(apikey.referenceId, organizationId))
      .orderBy(desc(apikey.createdAt));
    return rows.map(toRecord);
  }

  async find(organizationId: string, apiKeyId: string): Promise<ApiKeyRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(apikey)
      .where(and(eq(apikey.referenceId, organizationId), eq(apikey.id, apiKeyId)));
    return row ? toRecord(row) : undefined;
  }

  async revoke(apiKeyId: string, at: Date): Promise<void> {
    const q = getExecutor(this.db);
    const [row] = await q.select({ metadata: apikey.metadata }).from(apikey).where(eq(apikey.id, apiKeyId));
    const metadata = { ...metadataOf(row?.metadata ?? null), revokedAt: at.toISOString() };
    await q
      .update(apikey)
      .set({ enabled: false, metadata: JSON.stringify(metadata) })
      .where(eq(apikey.id, apiKeyId));
  }
}
