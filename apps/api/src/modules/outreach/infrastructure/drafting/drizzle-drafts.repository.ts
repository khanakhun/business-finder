import { type DbClient, getExecutor } from '@bf/db';
import { emailDrafts } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ne } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type { DraftRepository, StoredDraft } from '../../application/drafting/ports.ts';

@Injectable()
export class DrizzleDraftRepository implements DraftRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async insert(row: Parameters<DraftRepository['insert']>[0]) {
    const [stored] = await getExecutor(this.db).insert(emailDrafts).values(row).returning();
    if (!stored) throw new Error('draft not stored');
    return stored as StoredDraft;
  }

  async get(organizationId: string, id: string) {
    const [row] = await getExecutor(this.db)
      .select()
      .from(emailDrafts)
      .where(and(eq(emailDrafts.organizationId, organizationId), eq(emailDrafts.id, id)));
    return row as StoredDraft | undefined;
  }

  async update(organizationId: string, id: string, patch: Parameters<DraftRepository['update']>[2]) {
    const [row] = await getExecutor(this.db)
      .update(emailDrafts)
      .set(patch)
      .where(and(eq(emailDrafts.organizationId, organizationId), eq(emailDrafts.id, id)))
      .returning();
    if (!row) throw new Error('draft update matched no row');
    return row as StoredDraft;
  }

  async forBusiness(organizationId: string, businessId: string, limit: number) {
    return (await getExecutor(this.db)
      .select()
      .from(emailDrafts)
      .where(
        and(
          eq(emailDrafts.organizationId, organizationId),
          eq(emailDrafts.businessId, businessId),
          ne(emailDrafts.status, 'discarded'),
        ),
      )
      .orderBy(desc(emailDrafts.createdAt))
      .limit(limit)) as StoredDraft[];
  }
}
