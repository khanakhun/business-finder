import type { SourceProvider } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { businessSources } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { NewSourceRecord, SourceRecord, SourceRecordRepository } from '../application/ports.ts';

const toSourceRecord = (row: typeof businessSources.$inferSelect): SourceRecord => ({
  id: row.id,
  businessId: row.businessId,
  provider: row.provider,
  providerRef: row.providerRef,
  payload: row.payload,
  normalized: row.normalized,
  contentHash: row.contentHash,
  fetchedAt: row.fetchedAt,
  expiresAt: row.expiresAt,
  matchConfidence: row.matchConfidence,
  linkedBy: row.linkedBy,
  submittedByOrgId: row.submittedByOrgId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

@Injectable()
export class DrizzleSourceRecordRepository implements SourceRecordRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async upsert(
    record: NewSourceRecord,
  ): Promise<{ readonly record: SourceRecord; readonly changed: boolean }> {
    const executor = getExecutor(this.db);
    // Lock the existing row (if any) so concurrent fetches of one provider record serialize on the hash compare.
    const [previous] = await executor
      .select({ contentHash: businessSources.contentHash })
      .from(businessSources)
      .where(
        and(
          eq(businessSources.provider, record.provider),
          eq(businessSources.providerRef, record.providerRef),
        ),
      )
      .for('update');
    const [row] = await executor
      .insert(businessSources)
      .values(record)
      .onConflictDoUpdate({
        target: [businessSources.provider, businessSources.providerRef],
        set: {
          fetchedAt: sql`excluded.fetched_at`,
          expiresAt: sql`excluded.expires_at`,
          // A changed record replaces the stored content; links (business, confidence) are entity resolution's call.
          payload: sql`CASE WHEN ${businessSources.contentHash} = excluded.content_hash THEN ${businessSources.payload} ELSE excluded.payload END`,
          normalized: sql`CASE WHEN ${businessSources.contentHash} = excluded.content_hash THEN ${businessSources.normalized} ELSE excluded.normalized END`,
          contentHash: sql`excluded.content_hash`,
        },
      })
      .returning();
    if (!row) throw new Error(`Source record ${record.provider}/${record.providerRef} not written`);
    return { record: toSourceRecord(row), changed: previous?.contentHash !== record.contentHash };
  }

  async findByProviderRef(provider: SourceProvider, providerRef: string): Promise<SourceRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(businessSources)
      .where(and(eq(businessSources.provider, provider), eq(businessSources.providerRef, providerRef)));
    return row ? toSourceRecord(row) : undefined;
  }

  async listByBusiness(businessId: string): Promise<SourceRecord[]> {
    const rows = await getExecutor(this.db)
      .select()
      .from(businessSources)
      .where(eq(businessSources.businessId, businessId))
      .orderBy(asc(businessSources.fetchedAt), asc(businessSources.id));
    return rows.map(toSourceRecord);
  }
}
