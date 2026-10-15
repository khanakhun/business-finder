import type { ContactType } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { businessContacts } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { ContactRecord, ContactRepository } from '../application/ports.ts';

export const toContactRecord = (row: typeof businessContacts.$inferSelect): ContactRecord => ({
  id: row.id,
  businessId: row.businessId,
  type: row.type,
  value: row.value,
  normalizedValue: row.normalizedValue,
  subtype: row.subtype,
  personName: row.personName,
  source: row.source,
  sourceUrl: row.sourceUrl,
  publishedOnSite: row.publishedOnSite,
  confidence: row.confidence,
  submittedByOrgId: row.submittedByOrgId,
  verificationStatus: row.verificationStatus,
  verifiedAt: row.verifiedAt,
  firstSeenAt: row.firstSeenAt,
  lastSeenAt: row.lastSeenAt,
});

@Injectable()
export class DrizzleContactRepository implements ContactRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async listByBusiness(businessId: string): Promise<ContactRecord[]> {
    const rows = await getExecutor(this.db)
      .select()
      .from(businessContacts)
      .where(eq(businessContacts.businessId, businessId))
      .orderBy(asc(businessContacts.type), asc(businessContacts.firstSeenAt), asc(businessContacts.id));
    return rows.map(toContactRecord);
  }

  async find(
    businessId: string,
    type: ContactType,
    normalizedValue: string,
  ): Promise<ContactRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(businessContacts)
      .where(
        and(
          eq(businessContacts.businessId, businessId),
          eq(businessContacts.type, type),
          eq(businessContacts.normalizedValue, normalizedValue),
        ),
      );
    return row ? toContactRecord(row) : undefined;
  }
}
