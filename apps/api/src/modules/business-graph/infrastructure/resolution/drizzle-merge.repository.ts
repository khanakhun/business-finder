import { PIPELINE_STATUSES } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import {
  businessCategories,
  businesses,
  businessHours,
  businessMedia,
  businessReviews,
  businessSources,
  orgBusinesses,
  possibleDuplicates,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type { DuplicateRecord, MergeRepository } from '../../application/resolution/ports.ts';

/**
 * How far a workspace got with a business (merging two links keeps the further one). Disqualified is the least
 * advanced; lost sits after contact attempts; won is the end.
 */
export const PIPELINE_RANK: Readonly<Record<(typeof PIPELINE_STATUSES)[number], number>> = {
  disqualified: 0,
  new: 1,
  qualified: 2,
  lost: 3,
  contacted: 4,
  engaged: 5,
  meeting: 6,
  proposal: 7,
  won: 8,
};

const createdAtText = sql<string>`to_char(${possibleDuplicates.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

@Injectable()
export class DrizzleMergeRepository implements MergeRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async listSources(businessId: string) {
    const rows = await getExecutor(this.db)
      .select({ id: businessSources.id, normalized: businessSources.normalized })
      .from(businessSources)
      .where(eq(businessSources.businessId, businessId));
    return rows.map((r) => ({ id: r.id, hasNormalized: r.normalized !== null }));
  }

  async moveSources(fromId: string, toId: string, sourceIds?: readonly string[]): Promise<number> {
    const rows = await getExecutor(this.db)
      .update(businessSources)
      .set({ businessId: toId })
      .where(
        and(
          eq(businessSources.businessId, fromId),
          sourceIds ? inArray(businessSources.id, [...sourceIds]) : undefined,
        ),
      )
      .returning({ id: businessSources.id });
    return rows.length;
  }

  async moveSideData(fromId: string, toId: string): Promise<void> {
    const executor = getExecutor(this.db);
    // A manual contact the survivor holds from a provider keeps its manual protection and attribution.
    await executor.execute(sql`
      UPDATE business_contacts s SET source = 'manual', submitted_by_org_id = m.submitted_by_org_id,
        confidence = GREATEST(s.confidence, m.confidence)
      FROM business_contacts m
      WHERE s.business_id = ${toId} AND m.business_id = ${fromId} AND m.source = 'manual'
        AND s.type = m.type AND s.normalized_value = m.normalized_value`);
    // Contacts the survivor already has stay there; the rest move (manual ones included).
    await executor.execute(sql`
      UPDATE business_contacts c SET business_id = ${toId}
      WHERE c.business_id = ${fromId}
        AND NOT EXISTS (SELECT 1 FROM business_contacts s
                        WHERE s.business_id = ${toId} AND s.type = c.type AND s.normalized_value = c.normalized_value)`);
    await executor.execute(sql`DELETE FROM business_contacts WHERE business_id = ${fromId}`);
    await executor
      .update(businessMedia)
      .set({ businessId: toId })
      .where(eq(businessMedia.businessId, fromId));
    await executor
      .update(businessReviews)
      .set({ businessId: toId })
      .where(eq(businessReviews.businessId, fromId));
    // Recomputed from the sources on the survivor.
    await executor.delete(businessCategories).where(eq(businessCategories.businessId, fromId));
    await executor.delete(businessHours).where(eq(businessHours.businessId, fromId));
  }

  async mergeOrgLinks(
    fromId: string,
    toId: string,
  ): Promise<ReadonlyArray<{ readonly organizationId: string; readonly reason: string | null }>> {
    const executor = getExecutor(this.db);
    // Built from the constant table above (no user input).
    const rank = (column: string) =>
      sql.raw(
        `CASE ${column} ${Object.entries(PIPELINE_RANK)
          .map(([status, value]) => `WHEN '${status}' THEN ${value}`)
          .join(' ')} END`,
      );
    // Workspaces tracking both: keep the more advanced status (with its reasons and date), any do-not-contact
    // (with its reason), every tag and the survivor's owner (else the merged one's). Counters are refreshed by the
    // CRM when it re-points notes and tasks (BF-024).
    const further = sql`${rank('f.pipeline_status')} > ${rank('s.pipeline_status')}`;
    // Both businesses' workspace rows in id order first: other writers (scoring batches) lock them the same way.
    await executor.execute(sql`
      SELECT 1 FROM org_businesses WHERE business_id IN (${fromId}, ${toId})
      ORDER BY business_id, organization_id FOR UPDATE`);
    const suppressed = await executor.execute<{
      organization_id: string;
      reason: string | null;
      newly: boolean;
    }>(sql`
      WITH before AS (
        SELECT organization_id, do_not_contact AS was FROM org_businesses WHERE business_id = ${toId}
      )
      UPDATE org_businesses s SET
        pipeline_status = CASE WHEN ${further} THEN f.pipeline_status ELSE s.pipeline_status END,
        status_changed_at = CASE WHEN ${further} THEN f.status_changed_at ELSE s.status_changed_at END,
        lost_reason = CASE WHEN ${further} THEN f.lost_reason ELSE s.lost_reason END,
        disqualified_reason = CASE WHEN ${further} THEN f.disqualified_reason ELSE s.disqualified_reason END,
        do_not_contact = s.do_not_contact OR f.do_not_contact,
        do_not_contact_reason = CASE WHEN s.do_not_contact THEN s.do_not_contact_reason
          WHEN f.do_not_contact THEN f.do_not_contact_reason END,
        owner_user_id = COALESCE(s.owner_user_id, f.owner_user_id),
        tags = ARRAY(SELECT DISTINCT t FROM unnest(s.tags || f.tags) AS t ORDER BY t),
        created_at = LEAST(s.created_at, f.created_at)
      FROM org_businesses f, before b
      WHERE s.business_id = ${toId} AND f.business_id = ${fromId} AND f.organization_id = s.organization_id
        AND b.organization_id = s.organization_id
      RETURNING s.organization_id, f.do_not_contact_reason AS reason, (f.do_not_contact AND NOT b.was) AS newly`);
    await executor.execute(sql`
      DELETE FROM org_businesses f
      WHERE f.business_id = ${fromId}
        AND EXISTS (SELECT 1 FROM org_businesses s WHERE s.business_id = ${toId} AND s.organization_id = f.organization_id)`);
    await executor
      .update(orgBusinesses)
      .set({ businessId: toId })
      .where(eq(orgBusinesses.businessId, fromId));
    return [...suppressed]
      .filter((row) => row.newly)
      .map((row) => ({ organizationId: row.organization_id, reason: row.reason }));
  }

  async copyOrgLinks(fromId: string, toId: string): Promise<void> {
    await getExecutor(this.db).execute(sql`
      INSERT INTO org_businesses (organization_id, business_id, pipeline_status, added_via, added_ref, do_not_contact,
        do_not_contact_reason, owner_user_id, tags, status_changed_at, lost_reason, disqualified_reason)
      SELECT organization_id, ${toId}, pipeline_status, added_via, added_ref, do_not_contact,
        do_not_contact_reason, owner_user_id, tags, status_changed_at, lost_reason, disqualified_reason
      FROM org_businesses WHERE business_id = ${fromId}
      ON CONFLICT DO NOTHING`);
  }

  async repointDuplicates(fromId: string, toId: string): Promise<void> {
    const executor = getExecutor(this.db);
    await executor
      .update(possibleDuplicates)
      .set({ status: 'merged' })
      .where(
        or(
          and(eq(possibleDuplicates.businessAId, fromId), eq(possibleDuplicates.businessBId, toId)),
          and(eq(possibleDuplicates.businessAId, toId), eq(possibleDuplicates.businessBId, fromId)),
        ),
      );
    // Other open pairs of the merged record now concern the survivor (re-ordered; existing pairs win).
    await executor.execute(sql`
      INSERT INTO possible_duplicates (id, business_a_id, business_b_id, score, reasons, status)
      SELECT gen_random_uuid(), LEAST(${toId}::uuid, other), GREATEST(${toId}::uuid, other), score, reasons, status
      FROM (
        SELECT CASE WHEN business_a_id = ${fromId} THEN business_b_id ELSE business_a_id END AS other, score, reasons, status
        FROM possible_duplicates
        WHERE (business_a_id = ${fromId} OR business_b_id = ${fromId}) AND status = 'open'
      ) moved
      WHERE other <> ${toId}::uuid
      ON CONFLICT (business_a_id, business_b_id) DO NOTHING`);
    await executor.execute(sql`
      DELETE FROM possible_duplicates
      WHERE (business_a_id = ${fromId} OR business_b_id = ${fromId}) AND status = 'open'`);
  }

  async trackedByOthers(organizationId: string, businessIds: readonly string[]): Promise<Set<string>> {
    if (businessIds.length === 0) return new Set();
    const rows = await getExecutor(this.db)
      .selectDistinct({ businessId: orgBusinesses.businessId })
      .from(orgBusinesses)
      .where(
        and(
          ne(orgBusinesses.organizationId, organizationId),
          inArray(orgBusinesses.businessId, [...businessIds]),
        ),
      );
    return new Set(rows.map((r) => r.businessId));
  }

  async trackedBy(organizationId: string, businessIds: readonly string[]): Promise<Set<string>> {
    if (businessIds.length === 0) return new Set();
    const rows = await getExecutor(this.db)
      .select({ businessId: orgBusinesses.businessId })
      .from(orgBusinesses)
      .where(
        and(
          eq(orgBusinesses.organizationId, organizationId),
          inArray(orgBusinesses.businessId, [...businessIds]),
        ),
      );
    return new Set(rows.map((r) => r.businessId));
  }

  async listDuplicates(filter: Parameters<MergeRepository['listDuplicates']>[0]): Promise<DuplicateRecord[]> {
    const tracked = (column: typeof possibleDuplicates.businessAId | typeof possibleDuplicates.businessBId) =>
      sql`EXISTS (SELECT 1 FROM org_businesses o WHERE o.organization_id = ${filter.organizationId} AND o.business_id = ${column})`;
    const rows = await getExecutor(this.db)
      .select({ row: possibleDuplicates, createdAtText })
      .from(possibleDuplicates)
      .where(
        and(
          eq(possibleDuplicates.status, filter.status),
          // Only pairs the workspace can see entirely: it tracks both businesses.
          tracked(possibleDuplicates.businessAId),
          tracked(possibleDuplicates.businessBId),
          filter.businessId
            ? or(
                eq(possibleDuplicates.businessAId, filter.businessId),
                eq(possibleDuplicates.businessBId, filter.businessId),
              )
            : undefined,
          filter.before
            ? sql`(${possibleDuplicates.createdAt}, ${possibleDuplicates.id}) < (${filter.before.createdAt}::timestamptz, ${filter.before.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(possibleDuplicates.createdAt), desc(possibleDuplicates.id))
      .limit(filter.limit);
    return rows.map(({ row, createdAtText: text }) => toDuplicate(row, text));
  }

  async getDuplicate(id: string): Promise<DuplicateRecord | undefined> {
    const [found] = await getExecutor(this.db)
      .select({ row: possibleDuplicates, createdAtText })
      .from(possibleDuplicates)
      .where(eq(possibleDuplicates.id, id));
    return found ? toDuplicate(found.row, found.createdAtText) : undefined;
  }

  async setDuplicateStatus(id: string, status: 'merged' | 'dismissed'): Promise<void> {
    await getExecutor(this.db)
      .update(possibleDuplicates)
      .set({ status })
      .where(eq(possibleDuplicates.id, id));
  }

  async businessLabels(ids: readonly string[]) {
    if (ids.length === 0) return new Map();
    const rows = await getExecutor(this.db)
      .select({ id: businesses.id, displayName: businesses.displayName, locality: businesses.locality })
      .from(businesses)
      .where(inArray(businesses.id, [...ids]));
    return new Map(rows.map((r) => [r.id, { displayName: r.displayName, locality: r.locality }]));
  }
}

const toDuplicate = (row: typeof possibleDuplicates.$inferSelect, text: string): DuplicateRecord => ({
  id: row.id,
  businessAId: row.businessAId,
  businessBId: row.businessBId,
  score: row.score,
  reasons: row.reasons as unknown as DuplicateRecord['reasons'],
  status: row.status,
  createdAt: row.createdAt,
  createdAtText: text,
});
