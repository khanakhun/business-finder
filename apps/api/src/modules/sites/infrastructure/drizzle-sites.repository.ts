import { createHash } from 'node:crypto';
import { newId, type SiteIssue } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { businesses, orgBusinesses, sitePublications, sites, siteVersions } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, lt, lte, max, ne, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  NewVersion,
  SiteListFilter,
  SitesRepository,
  StoredPublication,
  StoredSite,
  StoredVersion,
  StoredVersionSummary,
} from '../application/ports.ts';

/** JSON with sorted keys: the same spec always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const specHash = (spec: unknown) => createHash('sha256').update(canonical(spec)).digest('hex');

const current = alias(siteVersions, 'current_version');
const preview = alias(sitePublications, 'active_preview');

type PublicationRow = typeof sitePublications.$inferSelect;
type VersionRow = typeof siteVersions.$inferSelect;

const toPublication = (row: PublicationRow): StoredPublication => ({
  id: row.id,
  siteId: row.siteId,
  versionId: row.versionId,
  environment: row.environment,
  hostname: row.hostname,
  status: row.status,
  publishedBy: row.publishedBy,
  publishedAt: row.publishedAt,
  expiresAt: row.expiresAt,
  endedAt: row.endedAt,
});

const toVersionSummary = (row: Omit<VersionRow, 'spec'>): StoredVersionSummary => ({
  id: row.id,
  siteId: row.siteId,
  versionNumber: row.versionNumber,
  specHash: row.specHash,
  schemaVersion: row.schemaVersion,
  authorType: row.authorType,
  authorId: row.authorId,
  parentVersionId: row.parentVersionId,
  changeSummary: row.changeSummary,
  issues: row.validation.issues,
  quality: row.quality,
  createdAt: row.createdAt,
});

@Injectable()
export class DrizzleSitesRepository implements SitesRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async trackedBusiness(organizationId: string, businessId: string) {
    const [row] = await getExecutor(this.db)
      .select({ id: businesses.id, name: businesses.displayName, locality: businesses.locality })
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(and(eq(orgBusinesses.organizationId, organizationId), eq(orgBusinesses.businessId, businessId)))
      .limit(1);
    return row;
  }

  async lockBusiness(organizationId: string, businessId: string): Promise<void> {
    await getExecutor(this.db).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sites:${organizationId}:${businessId}`}, 0))`,
    );
  }

  async siteOfBusiness(organizationId: string, businessId: string) {
    const [site] = await this.querySites(
      and(
        eq(sites.organizationId, organizationId),
        eq(sites.businessId, businessId),
        ne(sites.status, 'archived'),
      ),
      { order: 'oldest', limit: 1 },
    );
    return site;
  }

  async insertSite(site: Parameters<SitesRepository['insertSite']>[0]): Promise<boolean> {
    const rows = await getExecutor(this.db)
      .insert(sites)
      .values(site)
      .onConflictDoNothing({ target: sites.slug })
      .returning({ id: sites.id });
    return rows.length > 0;
  }

  async site(organizationId: string, siteId: string) {
    const [site] = await this.querySites(
      and(eq(sites.organizationId, organizationId), eq(sites.id, siteId)),
      {
        order: 'oldest',
        limit: 1,
      },
    );
    return site;
  }

  async lockSite(organizationId: string, siteId: string) {
    const [locked] = await getExecutor(this.db)
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.organizationId, organizationId), eq(sites.id, siteId)))
      .for('update');
    return locked ? this.site(organizationId, siteId) : undefined;
  }

  async sites(organizationId: string, filter: SiteListFilter) {
    const conditions: (SQL | undefined)[] = [eq(sites.organizationId, organizationId)];
    if (filter.status) conditions.push(eq(sites.status, filter.status));
    if (filter.businessId) conditions.push(eq(sites.businessId, filter.businessId));
    if (filter.authorType) conditions.push(eq(current.authorType, filter.authorType));
    if (filter.after) {
      conditions.push(
        or(
          lt(sites.createdAt, filter.after.createdAt),
          and(eq(sites.createdAt, filter.after.createdAt), lt(sites.id, filter.after.id)),
        ),
      );
    }
    return this.querySites(and(...conditions), { order: 'newest', limit: filter.limit });
  }

  async setSiteStatus(siteId: string, status: StoredSite['status']): Promise<void> {
    await getExecutor(this.db).update(sites).set({ status }).where(eq(sites.id, siteId));
  }

  async insertVersion(version: NewVersion): Promise<StoredVersion> {
    const executor = getExecutor(this.db);
    // Numbers are sequential per site; the site row is locked by the caller, so this read is stable.
    const [{ highest } = { highest: null }] = await executor
      .select({ highest: max(siteVersions.versionNumber) })
      .from(siteVersions)
      .where(eq(siteVersions.siteId, version.siteId));
    const [row] = await executor
      .insert(siteVersions)
      .values({
        id: newId(),
        siteId: version.siteId,
        versionNumber: (highest ?? 0) + 1,
        spec: version.spec,
        specHash: specHash(version.spec),
        schemaVersion: version.schemaVersion,
        authorType: version.authorType,
        authorId: version.authorId,
        parentVersionId: version.parentVersionId,
        changeSummary: version.changeSummary,
        validation: { issues: version.issues as SiteIssue[] },
      })
      .returning();
    if (!row) throw new Error('The version was not inserted');
    return { ...toVersionSummary(row), spec: row.spec };
  }

  async setCurrentVersion(siteId: string, versionId: string, defaultLocale: string): Promise<void> {
    await getExecutor(this.db)
      .update(sites)
      .set({ currentVersionId: versionId, defaultLocale })
      .where(eq(sites.id, siteId));
  }

  async version(siteId: string, versionId: string): Promise<StoredVersion | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(siteVersions)
      .where(and(eq(siteVersions.siteId, siteId), eq(siteVersions.id, versionId)))
      .limit(1);
    return row ? { ...toVersionSummary(row), spec: row.spec } : undefined;
  }

  async versions(siteId: string, page: { beforeNumber?: number | undefined; limit: number }) {
    const { spec: _spec, ...columns } = getTableColumns(siteVersions);
    const rows = await getExecutor(this.db)
      .select(columns)
      .from(siteVersions)
      .where(
        and(
          eq(siteVersions.siteId, siteId),
          page.beforeNumber ? lt(siteVersions.versionNumber, page.beforeNumber) : undefined,
        ),
      )
      .orderBy(desc(siteVersions.versionNumber))
      .limit(page.limit);
    return rows.map(toVersionSummary);
  }

  async activePublications(siteId: string) {
    const rows = await getExecutor(this.db)
      .select()
      .from(sitePublications)
      .where(and(eq(sitePublications.siteId, siteId), eq(sitePublications.status, 'active')))
      .orderBy(asc(sitePublications.environment));
    return rows.map(toPublication);
  }

  async insertPublication(publication: Parameters<SitesRepository['insertPublication']>[0]) {
    const [row] = await getExecutor(this.db)
      .insert(sitePublications)
      .values({ id: newId(), ...publication })
      .returning();
    if (!row) throw new Error('The publication was not inserted');
    return toPublication(row);
  }

  async endPublication(publicationId: string, status: 'expired' | 'unpublished', at: Date) {
    await getExecutor(this.db)
      .update(sitePublications)
      .set({ status, endedAt: at })
      .where(and(eq(sitePublications.id, publicationId), eq(sitePublications.status, 'active')));
  }

  async setPublicationExpiry(publicationId: string, expiresAt: Date) {
    await getExecutor(this.db)
      .update(sitePublications)
      .set({ expiresAt })
      .where(eq(sitePublications.id, publicationId));
  }

  async duePreviews(now: Date, limit: number) {
    const rows = await getExecutor(this.db)
      .select({
        publication: sitePublications,
        organizationId: sites.organizationId,
        businessId: sites.businessId,
      })
      .from(sitePublications)
      .innerJoin(sites, eq(sites.id, sitePublications.siteId))
      .where(
        and(
          eq(sitePublications.status, 'active'),
          eq(sitePublications.environment, 'preview'),
          lte(sitePublications.expiresAt, now),
        ),
      )
      .orderBy(asc(sitePublications.expiresAt))
      .limit(limit);
    return rows.map((row) => ({
      ...toPublication(row.publication),
      organizationId: row.organizationId,
      businessId: row.businessId,
    }));
  }

  /** Sites with their business name, current version number and active preview. */
  private async querySites(
    where: SQL | undefined,
    options: { order: 'oldest' | 'newest'; limit: number },
  ): Promise<StoredSite[]> {
    const rows = await getExecutor(this.db)
      .select({
        id: sites.id,
        organizationId: sites.organizationId,
        businessId: sites.businessId,
        businessName: businesses.displayName,
        slug: sites.slug,
        name: sites.name,
        status: sites.status,
        defaultLocale: sites.defaultLocale,
        currentVersionId: sites.currentVersionId,
        currentVersionNumber: current.versionNumber,
        previewHostname: preview.hostname,
        previewExpiresAt: preview.expiresAt,
        createdBy: sites.createdBy,
        createdAt: sites.createdAt,
        updatedAt: sites.updatedAt,
      })
      .from(sites)
      .innerJoin(businesses, eq(businesses.id, sites.businessId))
      .leftJoin(current, eq(current.id, sites.currentVersionId))
      .leftJoin(
        preview,
        and(eq(preview.siteId, sites.id), eq(preview.status, 'active'), eq(preview.environment, 'preview')),
      )
      .where(where)
      .orderBy(
        ...(options.order === 'newest'
          ? [desc(sites.createdAt), desc(sites.id)]
          : [asc(sites.createdAt), asc(sites.id)]),
      )
      .limit(options.limit);
    return rows.map(({ previewHostname, previewExpiresAt, ...site }) => ({
      ...site,
      preview: previewHostname ? { hostname: previewHostname, expiresAt: previewExpiresAt } : null,
    }));
  }
}
