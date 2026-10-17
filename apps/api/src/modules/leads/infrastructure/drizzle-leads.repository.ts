import type { LeadListQuery } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { businesses, generationJobs, siteLeads, sitePublications, sites, siteVersions } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { LeadSite, LeadsRepository, ListedLead, StoredLead } from '../application/ports.ts';

/** Leads (BF-048) and the site facts a public form needs (its preview publication, the version's origin). */
@Injectable()
export class DrizzleLeadsRepository implements LeadsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async siteForLead(siteId: string): Promise<LeadSite | undefined> {
    const [site] = await this.x
      .select({
        siteId: sites.id,
        organizationId: sites.organizationId,
        businessId: sites.businessId,
        siteName: sites.name,
        createdBy: sites.createdBy,
        businessName: businesses.displayName,
      })
      .from(sites)
      .innerJoin(businesses, eq(businesses.id, sites.businessId))
      .where(eq(sites.id, siteId))
      .limit(1);
    if (!site) return undefined;
    const [publication] = await this.x
      .select({
        id: sitePublications.id,
        hostname: sitePublications.hostname,
        status: sitePublications.status,
        endedAt: sitePublications.endedAt,
        versionId: sitePublications.versionId,
        environment: sitePublications.environment,
      })
      .from(sitePublications)
      .where(eq(sitePublications.siteId, siteId))
      // An active publication first (a live site after its preview ended), then the latest one.
      .orderBy(desc(sql`${sitePublications.status} = 'active'`), desc(sitePublications.publishedAt))
      .limit(1);
    let generationJobId: string | null = null;
    let engine: string | null = null;
    if (publication?.versionId) {
      const [version] = await this.x
        .select({ authorType: siteVersions.authorType, authorId: siteVersions.authorId })
        .from(siteVersions)
        .where(eq(siteVersions.id, publication.versionId))
        .limit(1);
      if (version?.authorType === 'generation_job' && version.authorId) {
        const [job] = await this.x
          .select({ id: generationJobs.id, engine: generationJobs.engineCurrent })
          .from(generationJobs)
          .where(eq(generationJobs.resultVersionId, publication.versionId))
          .limit(1);
        generationJobId = job?.id ?? null;
        engine = job?.engine ?? null;
      }
    }
    return {
      ...site,
      hostname: publication?.hostname ?? null,
      publicationId: publication?.id ?? null,
      environment: publication?.environment ?? null,
      active: publication?.status === 'active',
      endedAt: publication && publication.status !== 'active' ? (publication.endedAt ?? null) : null,
      versionId: publication?.versionId ?? null,
      generationJobId,
      engine,
    };
  }

  async bySubmission(siteId: string, submissionId: string) {
    const [row] = await this.x
      .select()
      .from(siteLeads)
      .where(and(eq(siteLeads.siteId, siteId), eq(siteLeads.submissionId, submissionId)))
      .limit(1);
    return row as StoredLead | undefined;
  }

  async insert(lead: Parameters<LeadsRepository['insert']>[0]) {
    const [row] = await this.x
      .insert(siteLeads)
      .values(lead)
      .onConflictDoNothing({ target: [siteLeads.siteId, siteLeads.submissionId] })
      .returning();
    if (row) return { lead: row as StoredLead, created: true };
    const existing = await this.bySubmission(lead.siteId, lead.submissionId);
    if (!existing) throw new Error('site lead vanished after a conflict');
    return { lead: existing, created: false };
  }

  private listed() {
    return this.x
      .select({ lead: siteLeads, businessName: businesses.displayName, siteName: sites.name })
      .from(siteLeads)
      .innerJoin(sites, eq(sites.id, siteLeads.siteId))
      .innerJoin(businesses, eq(businesses.id, siteLeads.businessId));
  }

  async list(organizationId: string, query: LeadListQuery & { after?: { createdAt: Date; id: string } }) {
    const { after } = query;
    const rows = await this.listed()
      .where(
        and(
          eq(siteLeads.organizationId, organizationId),
          // Spam stays out of the inbox unless asked for.
          query.status ? eq(siteLeads.status, query.status) : ne(siteLeads.status, 'spam'),
          query.kind ? eq(siteLeads.kind, query.kind) : undefined,
          query.source ? eq(siteLeads.source, query.source) : undefined,
          query.siteId ? eq(siteLeads.siteId, query.siteId) : undefined,
          query.businessId ? eq(siteLeads.businessId, query.businessId) : undefined,
          query.campaign ? sql`${siteLeads.attribution}->>'campaignRef' = ${query.campaign}` : undefined,
          query.from ? gte(siteLeads.createdAt, new Date(query.from)) : undefined,
          after
            ? or(
                lt(siteLeads.createdAt, after.createdAt),
                and(eq(siteLeads.createdAt, after.createdAt), lt(siteLeads.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(siteLeads.createdAt), desc(siteLeads.id))
      .limit(query.limit);
    return rows.map((row) => ({
      ...(row.lead as StoredLead),
      businessName: row.businessName,
      siteName: row.siteName,
    }));
  }

  async get(organizationId: string, leadId: string): Promise<ListedLead | undefined> {
    const [row] = await this.listed()
      .where(and(eq(siteLeads.organizationId, organizationId), eq(siteLeads.id, leadId)))
      .limit(1);
    return row
      ? { ...(row.lead as StoredLead), businessName: row.businessName, siteName: row.siteName }
      : undefined;
  }

  async update(organizationId: string, leadId: string, change: Parameters<LeadsRepository['update']>[2]) {
    const rows = await this.x
      .update(siteLeads)
      .set({
        ...(change.status ? { status: change.status } : {}),
        ...(change.handledBy !== undefined ? { handledBy: change.handledBy } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(siteLeads.organizationId, organizationId), eq(siteLeads.id, leadId)))
      .returning({ id: siteLeads.id });
    return rows.length > 0;
  }

  async countNew(organizationId: string) {
    const [row] = await this.x
      .select({ count: sql<number>`count(*)::int` })
      .from(siteLeads)
      .where(and(eq(siteLeads.organizationId, organizationId), eq(siteLeads.status, 'new')));
    return row?.count ?? 0;
  }

  async deleteBefore(before: Date, spamBefore: Date, limit: number) {
    const old = await this.x
      .select({ id: siteLeads.id })
      .from(siteLeads)
      .where(
        or(
          lt(siteLeads.createdAt, before),
          and(eq(siteLeads.status, 'spam'), lt(siteLeads.createdAt, spamBefore)),
        ),
      )
      .limit(limit);
    if (old.length === 0) return 0;
    await this.x.delete(siteLeads).where(
      inArray(
        siteLeads.id,
        old.map((row) => row.id),
      ),
    );
    return old.length;
  }
}
