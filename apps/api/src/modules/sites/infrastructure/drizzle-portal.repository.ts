import type { PortalLead } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import {
  member,
  siteApprovals,
  siteChangeRequests,
  sitePortalAttachments,
  sitePortalGrants,
  siteVersions,
  siteViewDaily,
  user,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  ApprovalRecord,
  AttachmentRecord,
  ChangeRequestRecord,
  PortalGrantRecord,
  PortalRepository,
  PortalSiteRecord,
  PortalViews,
} from '../application/client-portal/ports.ts';

type SiteRow = {
  site_id: string;
  organization_id: string;
  business_id: string;
  name: string;
  status: string;
  live_hostname: string | null;
  preview_hostname: string | null;
  pending_approvals: number;
};

const toSite = (row: SiteRow): PortalSiteRecord => ({
  siteId: row.site_id,
  organizationId: row.organization_id,
  businessId: row.business_id,
  name: row.name,
  status: row.status,
  liveHostname: row.live_hostname,
  previewHostname: row.preview_hostname,
  pendingApprovals: Number(row.pending_approvals),
});

/** Grants, the client's sites and their stats, leads, change requests and approvals (BF-062). */
@Injectable()
export class DrizzlePortalRepository implements PortalRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async grants(organizationId: string, siteId: string): Promise<PortalGrantRecord[]> {
    return getExecutor(this.db)
      .select()
      .from(sitePortalGrants)
      .where(
        and(
          eq(sitePortalGrants.organizationId, organizationId),
          eq(sitePortalGrants.siteId, siteId),
          isNull(sitePortalGrants.revokedAt),
        ),
      )
      .orderBy(asc(sitePortalGrants.createdAt));
  }

  async grant(input: {
    id: string;
    organizationId: string;
    siteId: string;
    email: string;
    invitedBy: string | null;
  }): Promise<PortalGrantRecord> {
    const executor = getExecutor(this.db);
    await executor
      .insert(sitePortalGrants)
      .values({ ...input, email: input.email.toLowerCase() })
      .onConflictDoNothing();
    const [row] = await executor
      .select()
      .from(sitePortalGrants)
      .where(
        and(
          eq(sitePortalGrants.siteId, input.siteId),
          eq(sitePortalGrants.email, input.email.toLowerCase()),
          isNull(sitePortalGrants.revokedAt),
        ),
      );
    return row as PortalGrantRecord;
  }

  async revoke(organizationId: string, siteId: string, grantId: string, now: Date): Promise<boolean> {
    const rows = await getExecutor(this.db)
      .update(sitePortalGrants)
      .set({ revokedAt: now })
      .where(
        and(
          eq(sitePortalGrants.id, grantId),
          eq(sitePortalGrants.organizationId, organizationId),
          eq(sitePortalGrants.siteId, siteId),
          isNull(sitePortalGrants.revokedAt),
        ),
      )
      .returning({ id: sitePortalGrants.id });
    return rows.length > 0;
  }

  async isStaff(email: string): Promise<boolean> {
    const [row] = await getExecutor(this.db)
      .select({ id: member.id })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(user.email, email.toLowerCase()))
      .limit(1);
    return row !== undefined;
  }

  async claim(userId: string, email: string, now: Date): Promise<void> {
    await getExecutor(this.db)
      .update(sitePortalGrants)
      .set({ userId, acceptedAt: now })
      .where(
        and(
          eq(sitePortalGrants.email, email.toLowerCase()),
          isNull(sitePortalGrants.userId),
          isNull(sitePortalGrants.revokedAt),
        ),
      );
  }

  private async siteRows(where: SQL): Promise<PortalSiteRecord[]> {
    const rows = await getExecutor(this.db).execute<SiteRow>(sql`
      SELECT s.id::text AS site_id, s.organization_id::text, s.business_id::text, s.name, s.status,
        (SELECT p.hostname FROM site_publications p
          WHERE p.site_id = s.id AND p.environment = 'live' AND p.status = 'active'
          ORDER BY p.published_at DESC LIMIT 1) AS live_hostname,
        (SELECT p.hostname FROM site_publications p
          WHERE p.site_id = s.id AND p.environment = 'preview' AND p.status = 'active'
          ORDER BY p.published_at DESC LIMIT 1) AS preview_hostname,
        (SELECT count(*)::int FROM site_approvals a
          WHERE a.site_id = s.id AND a.status = 'pending') AS pending_approvals
      FROM sites s
      WHERE ${where}
      ORDER BY s.name`);
    return [...rows].map(toSite);
  }

  sites(userId: string): Promise<PortalSiteRecord[]> {
    return this.siteRows(sql`EXISTS (SELECT 1 FROM site_portal_grants g
      WHERE g.site_id = s.id AND g.organization_id = s.organization_id
        AND g.user_id = ${userId}::uuid AND g.revoked_at IS NULL)`);
  }

  async site(userId: string, siteId: string): Promise<PortalSiteRecord | undefined> {
    const [row] =
      await this.siteRows(sql`s.id = ${siteId}::uuid AND EXISTS (SELECT 1 FROM site_portal_grants g
      WHERE g.site_id = s.id AND g.organization_id = s.organization_id
        AND g.user_id = ${userId}::uuid AND g.revoked_at IS NULL)`);
    return row;
  }

  async agencySite(organizationId: string, siteId: string): Promise<PortalSiteRecord | undefined> {
    const [row] = await this.siteRows(
      sql`s.id = ${siteId}::uuid AND s.organization_id = ${organizationId}::uuid`,
    );
    return row;
  }

  async views(siteId: string, sinceDay: string): Promise<PortalViews> {
    const rows = await getExecutor(this.db)
      .select({
        day: siteViewDaily.day,
        pageViews: siteViewDaily.pageViews,
        uniqueEstimate: siteViewDaily.uniqueEstimate,
        byLocale: siteViewDaily.byLocale,
      })
      .from(siteViewDaily)
      .where(and(eq(siteViewDaily.siteId, siteId), gte(siteViewDaily.day, sinceDay)))
      .orderBy(asc(siteViewDaily.day));
    const byLocale: Record<string, number> = {};
    for (const row of rows)
      for (const [locale, count] of Object.entries(row.byLocale))
        byLocale[locale] = (byLocale[locale] ?? 0) + count;
    return {
      pageViews: rows.reduce((sum, row) => sum + row.pageViews, 0),
      uniqueEstimate: rows.reduce((sum, row) => sum + row.uniqueEstimate, 0),
      byLocale,
      daily: rows.map((row) => ({ day: row.day, pageViews: row.pageViews })),
    };
  }

  async leadCount(siteId: string, since: Date): Promise<number> {
    const [row] = await getExecutor(this.db).execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM site_leads
      WHERE site_id = ${siteId}::uuid AND kind <> 'opt_out' AND status <> 'spam'
        AND created_at >= ${since.toISOString()}::timestamptz`);
    return Number(row?.count ?? 0);
  }

  async leads(siteId: string, limit: number): Promise<PortalLead[]> {
    const rows = await getExecutor(this.db).execute<{
      id: string;
      kind: PortalLead['kind'];
      status: PortalLead['status'];
      name: string | null;
      email: string | null;
      phone: string | null;
      message: string | null;
      locale: string;
      created_at: Date | string;
    }>(sql`
      SELECT id::text, kind, status, name, email::text, phone, message, locale, created_at
      FROM site_leads
      WHERE site_id = ${siteId}::uuid AND kind <> 'opt_out' AND status <> 'spam'
      ORDER BY created_at DESC LIMIT ${limit}`);
    return [...rows].map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      name: row.name,
      email: row.email,
      phone: row.phone,
      message: row.message,
      locale: row.locale,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async addAttachment(input: {
    id: string;
    organizationId: string;
    siteId: string;
    uploadedBy: string;
    objectKey: string;
    contentType: string;
    bytes: number;
  }): Promise<void> {
    await getExecutor(this.db).insert(sitePortalAttachments).values(input);
  }

  async attachments(siteId: string, ids: readonly string[]): Promise<AttachmentRecord[]> {
    if (ids.length === 0) return [];
    return getExecutor(this.db)
      .select({
        id: sitePortalAttachments.id,
        siteId: sitePortalAttachments.siteId,
        uploadedBy: sitePortalAttachments.uploadedBy,
        objectKey: sitePortalAttachments.objectKey,
        contentType: sitePortalAttachments.contentType,
        changeRequestId: sitePortalAttachments.changeRequestId,
      })
      .from(sitePortalAttachments)
      .where(and(eq(sitePortalAttachments.siteId, siteId), inArray(sitePortalAttachments.id, [...ids])));
  }

  async addChangeRequest(
    input: {
      id: string;
      organizationId: string;
      siteId: string;
      requestedBy: string;
      message: string;
      pageHint: string | null;
    },
    attachmentIds: readonly string[],
  ): Promise<void> {
    const executor = getExecutor(this.db);
    await executor.insert(siteChangeRequests).values(input);
    if (attachmentIds.length > 0)
      await executor
        .update(sitePortalAttachments)
        .set({ changeRequestId: input.id })
        .where(
          and(
            eq(sitePortalAttachments.siteId, input.siteId),
            inArray(sitePortalAttachments.id, [...attachmentIds]),
            isNull(sitePortalAttachments.changeRequestId),
          ),
        );
  }

  async setChangeRequestTask(id: string, taskId: string): Promise<void> {
    await getExecutor(this.db)
      .update(siteChangeRequests)
      .set({ taskId })
      .where(eq(siteChangeRequests.id, id));
  }

  async changeRequests(siteId: string, limit: number): Promise<ChangeRequestRecord[]> {
    const executor = getExecutor(this.db);
    const requests = await executor
      .select()
      .from(siteChangeRequests)
      .where(eq(siteChangeRequests.siteId, siteId))
      .orderBy(desc(siteChangeRequests.createdAt))
      .limit(limit);
    if (requests.length === 0) return [];
    const files = await executor
      .select({
        id: sitePortalAttachments.id,
        changeRequestId: sitePortalAttachments.changeRequestId,
        objectKey: sitePortalAttachments.objectKey,
        contentType: sitePortalAttachments.contentType,
      })
      .from(sitePortalAttachments)
      .where(
        inArray(
          sitePortalAttachments.changeRequestId,
          requests.map((request) => request.id),
        ),
      );
    return requests.map((request) => ({
      id: request.id,
      siteId: request.siteId,
      message: request.message,
      pageHint: request.pageHint,
      taskId: request.taskId,
      createdAt: request.createdAt,
      attachments: files
        .filter((file) => file.changeRequestId === request.id)
        .map(({ id, objectKey, contentType }) => ({ id, objectKey, contentType })),
    }));
  }

  async versionNumber(siteId: string, versionId: string): Promise<number | undefined> {
    const [row] = await getExecutor(this.db)
      .select({ versionNumber: siteVersions.versionNumber })
      .from(siteVersions)
      .where(and(eq(siteVersions.id, versionId), eq(siteVersions.siteId, siteId)));
    return row?.versionNumber;
  }

  async requestApproval(input: {
    id: string;
    organizationId: string;
    siteId: string;
    versionId: string;
    note: string | null;
    requestedBy: string | null;
  }): Promise<void> {
    await getExecutor(this.db).insert(siteApprovals).values(input).onConflictDoNothing();
  }

  async approvals(siteId: string, limit: number): Promise<ApprovalRecord[]> {
    return getExecutor(this.db)
      .select({
        id: siteApprovals.id,
        organizationId: siteApprovals.organizationId,
        siteId: siteApprovals.siteId,
        versionId: siteApprovals.versionId,
        versionNumber: siteVersions.versionNumber,
        note: siteApprovals.note,
        status: siteApprovals.status,
        comment: siteApprovals.comment,
        requestedAt: siteApprovals.requestedAt,
        decidedAt: siteApprovals.decidedAt,
      })
      .from(siteApprovals)
      .innerJoin(siteVersions, eq(siteVersions.id, siteApprovals.versionId))
      .where(eq(siteApprovals.siteId, siteId))
      .orderBy(desc(siteApprovals.requestedAt))
      .limit(limit);
  }

  async decide(
    siteId: string,
    approvalId: string,
    decision: { status: 'approved' | 'changes_requested'; comment: string | null; userId: string; now: Date },
  ): Promise<ApprovalRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .update(siteApprovals)
      .set({
        status: decision.status,
        comment: decision.comment,
        decidedBy: decision.userId,
        decidedAt: decision.now,
      })
      .where(
        and(
          eq(siteApprovals.id, approvalId),
          eq(siteApprovals.siteId, siteId),
          eq(siteApprovals.status, 'pending'),
        ),
      )
      .returning({ id: siteApprovals.id });
    if (!row) return undefined;
    return (await this.approvals(siteId, 100)).find((approval) => approval.id === approvalId);
  }
}
