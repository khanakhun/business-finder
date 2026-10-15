import { type DbClient, getExecutor } from '@bf/db';
import { orgBusinesses } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { OrgBusinessRecord, OrgBusinessRepository } from '../application/ports.ts';

const toRecord = (row: typeof orgBusinesses.$inferSelect): OrgBusinessRecord => ({
  organizationId: row.organizationId,
  businessId: row.businessId,
  pipelineStatus: row.pipelineStatus,
  addedVia: row.addedVia,
  addedRef: row.addedRef,
  doNotContact: row.doNotContact,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

@Injectable()
export class DrizzleOrgBusinessRepository implements OrgBusinessRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async track(input: Parameters<OrgBusinessRepository['track']>[0]) {
    const [inserted] = await getExecutor(this.db)
      .insert(orgBusinesses)
      .values(input)
      .onConflictDoNothing({ target: [orgBusinesses.organizationId, orgBusinesses.businessId] })
      .returning();
    if (inserted) return { record: toRecord(inserted), created: true };
    const existing = await this.find(input.organizationId, input.businessId);
    if (!existing) throw new Error(`org_businesses row for ${input.businessId} vanished`);
    return { record: existing, created: false };
  }

  async find(organizationId: string, businessId: string): Promise<OrgBusinessRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(orgBusinesses)
      .where(and(eq(orgBusinesses.organizationId, organizationId), eq(orgBusinesses.businessId, businessId)));
    return row ? toRecord(row) : undefined;
  }
}
