import { type DbClient, getExecutor } from '@bf/db';
import {
  businessContacts,
  businesses,
  businessHours,
  callScripts,
  categories,
  manualContactLogs,
  orgBusinesses,
  outboundMessages,
  tasks,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type {
  AssistNumber,
  AssistReader,
  CallScriptCache,
  CallScriptKey,
} from '../../application/assist/ports.ts';
import type { OpeningHours } from '../../domain/assist/best-time.ts';

// The call assist's read model and script cache (BF-057). Read-only across contexts (business graph, CRM, outbound).

const time = (value: string) => value.slice(0, 5);

@Injectable()
export class DrizzleAssistReader implements AssistReader, CallScriptCache {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private select() {
    return getExecutor(this.db)
      .select({
        id: businesses.id,
        name: businesses.displayName,
        tier: orgBusinesses.tier,
        categoryPath: sql<string | null>`${categories.path}::text`,
        doNotContact: orgBusinesses.doNotContact,
      })
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .leftJoin(categories, eq(categories.id, businesses.primaryCategoryId));
  }

  async business(organizationId: string, businessId: string) {
    const [row] = await this.select().where(
      and(eq(orgBusinesses.organizationId, organizationId), eq(orgBusinesses.businessId, businessId)),
    );
    return row;
  }

  async businesses(organizationId: string, businessIds: readonly string[]) {
    if (businessIds.length === 0) return [];
    return this.select().where(
      and(
        eq(orgBusinesses.organizationId, organizationId),
        inArray(orgBusinesses.businessId, [...businessIds]),
      ),
    );
  }

  async numbers(organizationId: string, businessIds: readonly string[]) {
    const byBusiness = new Map<string, AssistNumber[]>();
    if (businessIds.length === 0) return byBusiness;
    const rows = await getExecutor(this.db)
      .select({
        businessId: businessContacts.businessId,
        contactId: businessContacts.id,
        type: businessContacts.type,
        e164: businessContacts.normalizedValue,
        subtype: businessContacts.subtype,
        source: businessContacts.source,
        sourceUrl: businessContacts.sourceUrl,
      })
      .from(businessContacts)
      .where(
        and(
          inArray(businessContacts.businessId, [...businessIds]),
          inArray(businessContacts.type, ['phone', 'whatsapp']),
          or(
            isNull(businessContacts.submittedByOrgId),
            eq(businessContacts.submittedByOrgId, organizationId),
          ),
          sql`${businessContacts.verificationStatus} <> 'invalid'`,
        ),
      )
      .orderBy(desc(businessContacts.confidence), asc(businessContacts.createdAt));
    for (const row of rows) {
      const list = byBusiness.get(row.businessId) ?? [];
      list.push({ ...row, type: row.type as AssistNumber['type'] });
      byBusiness.set(row.businessId, list);
    }
    return byBusiness;
  }

  async hours(businessIds: readonly string[]) {
    const byBusiness = new Map<string, OpeningHours[]>();
    if (businessIds.length === 0) return byBusiness;
    const rows = await getExecutor(this.db)
      .select()
      .from(businessHours)
      .where(inArray(businessHours.businessId, [...businessIds]));
    for (const row of rows) {
      const list = byBusiness.get(row.businessId) ?? [];
      list.push({ weekday: row.weekday, opensAt: time(row.opensAt), closesAt: time(row.closesAt) });
      byBusiness.set(row.businessId, list);
    }
    return byBusiness;
  }

  async callTasks(organizationId: string, userId: string | null, until: Date) {
    return getExecutor(this.db)
      .select({ taskId: tasks.id, title: tasks.title, dueAt: tasks.dueAt, businessId: tasks.businessId })
      .from(tasks)
      .where(
        and(
          eq(tasks.organizationId, organizationId),
          eq(tasks.status, 'open'),
          eq(tasks.type, 'call'),
          lte(tasks.dueAt, until),
          userId ? or(eq(tasks.assigneeId, userId), isNull(tasks.assigneeId)) : isNull(tasks.assigneeId),
        ),
      )
      .orderBy(asc(tasks.dueAt))
      .limit(50);
  }

  async suggestions(organizationId: string, since: Date, limit: number) {
    const sinceIso = since.toISOString();
    const rows = await getExecutor(this.db)
      .select({ businessId: orgBusinesses.businessId })
      .from(orgBusinesses)
      .where(
        and(
          eq(orgBusinesses.organizationId, organizationId),
          inArray(orgBusinesses.tier, ['A', 'B']),
          eq(orgBusinesses.doNotContact, false),
          inArray(orgBusinesses.pipelineStatus, ['new', 'qualified', 'contacted', 'engaged']),
          sql`EXISTS (SELECT 1 FROM ${businessContacts} c WHERE c.business_id = ${orgBusinesses.businessId}
                AND c.type = 'phone' AND c.verification_status <> 'invalid'
                AND (c.submitted_by_org_id IS NULL OR c.submitted_by_org_id = ${organizationId}))`,
          sql`NOT EXISTS (SELECT 1 FROM ${manualContactLogs} m WHERE m.organization_id = ${organizationId}
                AND m.business_id = ${orgBusinesses.businessId} AND m.created_at >= ${sinceIso})`,
          sql`NOT EXISTS (SELECT 1 FROM ${outboundMessages} o WHERE o.organization_id = ${organizationId}
                AND o.business_id = ${orgBusinesses.businessId} AND o.sent_at >= ${sinceIso})`,
        ),
      )
      .orderBy(asc(orgBusinesses.tier), desc(orgBusinesses.score))
      .limit(limit);
    return rows.map((row) => row.businessId);
  }

  async find(key: CallScriptKey) {
    const [row] = await getExecutor(this.db)
      .select({ script: callScripts.script })
      .from(callScripts)
      .where(
        and(
          eq(callScripts.organizationId, key.organizationId),
          eq(callScripts.businessId, key.businessId),
          eq(callScripts.offer, key.offer),
          eq(callScripts.locale, key.locale),
          eq(callScripts.factsHash, key.factsHash),
        ),
      );
    return row?.script;
  }

  async save(key: CallScriptKey, script: Parameters<CallScriptCache['save']>[1]) {
    await getExecutor(this.db)
      .insert(callScripts)
      .values({ ...key, script })
      .onConflictDoUpdate({
        target: [
          callScripts.organizationId,
          callScripts.businessId,
          callScripts.offer,
          callScripts.locale,
          callScripts.factsHash,
        ],
        set: { script, createdAt: sql`now()` },
      });
  }
}
