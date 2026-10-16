import {
  decodeCursor,
  encodeCursor,
  NotFoundError,
  type SiteDetail,
  type SiteListQuery,
  type SitePage,
  type SiteVersion,
  type SiteVersionDiff,
  type SiteVersionPage,
  ValidationError,
} from '@bf/contracts';
import { migrateSpec } from '@bf/site-schema';
import { Inject, Injectable } from '@nestjs/common';
import { diffSpecs } from '../domain/version-diff.ts';
import { toSiteDetail, toSiteSummary, toVersion, toVersionSummary } from './mappers.ts';
import { SITES_REPOSITORY, type SitesRepository, type StoredSite } from './ports.ts';

const invalidCursor = () =>
  new ValidationError('Invalid cursor.', [{ path: ['cursor'], message: 'Invalid cursor' }]);

/** Reads of the sites module (BF-035): sites, their versions and the differences between versions. */
@Injectable()
export class SiteQueries {
  constructor(@Inject(SITES_REPOSITORY) private readonly repository: SitesRepository) {}

  async list(organizationId: string, query: SiteListQuery): Promise<SitePage> {
    let after: { createdAt: Date; id: string } | undefined;
    if (query.cursor) {
      const data = await decodeCursor(query.cursor);
      const [createdAt] = data.sort;
      if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) throw invalidCursor();
      after = { createdAt: new Date(createdAt), id: data.id };
    }
    const rows = await this.repository.sites(organizationId, {
      status: query.status,
      businessId: query.businessId,
      authorType: query.authorType,
      after,
      limit: query.limit + 1,
    });
    const items = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? items.at(-1) : undefined;
    return {
      items: items.map(toSiteSummary),
      nextCursor: last ? await encodeCursor({ sort: [last.createdAt.toISOString()], id: last.id }) : null,
    };
  }

  async get(organizationId: string, siteId: string): Promise<SiteDetail> {
    const site = await this.site(organizationId, siteId);
    const current = site.currentVersionId
      ? await this.repository.version(site.id, site.currentVersionId)
      : undefined;
    return toSiteDetail(site, current, await this.repository.activePublications(site.id));
  }

  async versions(
    organizationId: string,
    siteId: string,
    page: { cursor?: string | undefined; limit: number },
  ) {
    const site = await this.site(organizationId, siteId);
    let beforeNumber: number | undefined;
    if (page.cursor) {
      const data = await decodeCursor(page.cursor);
      const [number] = data.sort;
      if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) throw invalidCursor();
      beforeNumber = number;
    }
    const rows = await this.repository.versions(site.id, { beforeNumber, limit: page.limit + 1 });
    const items = rows.slice(0, page.limit);
    const last = rows.length > page.limit ? items.at(-1) : undefined;
    const result: SiteVersionPage = {
      items: items.map(toVersionSummary),
      nextCursor: last ? await encodeCursor({ sort: [last.versionNumber], id: last.id }) : null,
    };
    return result;
  }

  async version(organizationId: string, siteId: string, versionId: string): Promise<SiteVersion> {
    const site = await this.site(organizationId, siteId);
    const version = await this.repository.version(site.id, versionId);
    if (!version) throw new NotFoundError('SiteVersion', versionId);
    return toVersion(version);
  }

  async diff(organizationId: string, siteId: string, from: string, to: string): Promise<SiteVersionDiff> {
    const site = await this.site(organizationId, siteId);
    const [a, b] = await Promise.all([
      this.repository.version(site.id, from),
      this.repository.version(site.id, to),
    ]);
    if (!a) throw new NotFoundError('SiteVersion', from);
    if (!b) throw new NotFoundError('SiteVersion', to);
    return { from, to, ...diffSpecs(migrateSpec(a.spec), migrateSpec(b.spec)) } as SiteVersionDiff;
  }

  private async site(organizationId: string, siteId: string): Promise<StoredSite> {
    const site = await this.repository.site(organizationId, siteId);
    if (!site) throw new NotFoundError('Site', siteId);
    return site;
  }
}
