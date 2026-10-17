import { type DbClient, getExecutor } from '@bf/db';
import { businessContacts, orgBusinesses } from '@bf/db/schema';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  type DataSubjectQuery,
  type PersonalDataProvider,
  PersonalDataRegistry,
} from '../../compliance/index.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';

// Business contact points that identify a person (BF-055 DSR provider): emails and phones of businesses the workspace
// tracks. DECISION(BF-055): the business graph is shared across workspaces, so erasing a contact point removes it
// from the graph for everyone (personal data is erased, not hidden per workspace); "anonymize" keeps the row but
// drops the person's name and replaces the value.

const mask = (value: string) =>
  value.includes('@') ? `${value.slice(0, 1)}***@${value.split('@')[1]}` : `${value.slice(0, 4)}***`;

@Injectable()
export class ContactPersonalData implements PersonalDataProvider, OnModuleInit {
  readonly id = 'business_graph.contacts';
  readonly categories = ['contact_details', 'names'] as const;

  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    private readonly registry: PersonalDataRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async find(subject: DataSubjectQuery) {
    const values = [subject.email, subject.phone].filter((value): value is string => Boolean(value));
    if (values.length === 0) return [];
    const rows = await getExecutor(this.db)
      .select({
        id: businessContacts.id,
        type: businessContacts.type,
        value: businessContacts.normalizedValue,
      })
      .from(businessContacts)
      .innerJoin(
        orgBusinesses,
        and(
          eq(orgBusinesses.businessId, businessContacts.businessId),
          eq(orgBusinesses.organizationId, subject.organizationId),
        ),
      )
      .where(or(...values.map((value) => eq(businessContacts.normalizedValue, value))));
    return rows.map((row) => ({ id: row.id, summary: `${row.type} ${mask(row.value)}` }));
  }

  async export(_subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    const rows = await getExecutor(this.db)
      .select({
        businessId: businessContacts.businessId,
        type: businessContacts.type,
        value: businessContacts.value,
        personName: businessContacts.personName,
        source: businessContacts.source,
        sourceUrl: businessContacts.sourceUrl,
        firstSeenAt: businessContacts.firstSeenAt,
        lastSeenAt: businessContacts.lastSeenAt,
      })
      .from(businessContacts)
      .where(
        inArray(
          businessContacts.id,
          refs.map((ref) => ref.id),
        ),
      );
    return [{ name: 'business_contacts', rows }];
  }

  async erase(_subject: DataSubjectQuery, refs: readonly { id: string }[], mode: 'delete' | 'anonymize') {
    if (refs.length === 0) return { erased: 0, manual: 0 };
    const ids = refs.map((ref) => ref.id);
    const x = getExecutor(this.db);
    if (mode === 'delete') {
      const deleted = await x
        .delete(businessContacts)
        .where(inArray(businessContacts.id, ids))
        .returning({ id: businessContacts.id });
      return { erased: deleted.length, manual: 0 };
    }
    const updated = await x
      .update(businessContacts)
      .set({
        personName: null,
        // Unique per row: (business, type, normalized value) is unique.
        value: sql`'erased:' || ${businessContacts.id}`,
        normalizedValue: sql`'erased:' || ${businessContacts.id}`,
        sourceUrl: null,
        verificationDetails: null,
      })
      .where(inArray(businessContacts.id, ids))
      .returning({ id: businessContacts.id });
    return { erased: updated.length, manual: 0 };
  }
}
