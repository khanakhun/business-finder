import { newId } from '@bf/contracts';
import type {
  NewVersion,
  SiteInsights,
  SiteListFilter,
  SitesRepository,
  StoredPublication,
  StoredSite,
  StoredVersion,
} from './ports.ts';

/** An in-memory `SitesRepository` for unit tests (no locks: tests are sequential). */
export class InMemorySitesRepository implements SitesRepository {
  readonly businesses = new Map<
    string,
    { id: string; name: string; locality: string | null; organizationId: string }
  >();
  readonly siteRows = new Map<
    string,
    Omit<StoredSite, 'businessName' | 'currentVersionNumber' | 'preview' | 'createdAtKey'>
  >();
  readonly versionRows = new Map<string, StoredVersion>();
  readonly publications = new Map<string, StoredPublication>();
  private tick = 0;

  addBusiness(organizationId: string, name: string, locality: string | null = null): string {
    const id = newId();
    this.businesses.set(id, { id, name, locality, organizationId });
    return id;
  }

  async trackedBusiness(organizationId: string, businessId: string) {
    const business = this.businesses.get(businessId);
    return business?.organizationId === organizationId
      ? { id: business.id, name: business.name, locality: business.locality }
      : undefined;
  }

  async lockBusiness(): Promise<void> {}

  async sitesOfBusiness(organizationId: string, businessId: string) {
    return [...this.siteRows.values()]
      .filter(
        (site) =>
          site.organizationId === organizationId &&
          site.businessId === businessId &&
          site.status !== 'archived',
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((row) => this.view(row.id) as StoredSite);
  }

  async insertSite(site: Parameters<SitesRepository['insertSite']>[0]): Promise<boolean> {
    if ([...this.siteRows.values()].some((row) => row.slug === site.slug)) return false;
    const now = new Date(Date.UTC(2026, 9, 14, 12, 0, this.tick++));
    this.siteRows.set(site.id, {
      ...site,
      status: 'draft',
      currentVersionId: null,
      createdAt: now,
      updatedAt: now,
    });
    return true;
  }

  async site(organizationId: string, siteId: string) {
    const row = this.siteRows.get(siteId);
    return row?.organizationId === organizationId ? this.view(siteId) : undefined;
  }

  lockSite(organizationId: string, siteId: string) {
    return this.site(organizationId, siteId);
  }

  async sites(organizationId: string, filter: SiteListFilter) {
    return [...this.siteRows.values()]
      .filter((row) => row.organizationId === organizationId)
      .filter((row) => !filter.status || row.status === filter.status)
      .filter((row) => !filter.businessId || row.businessId === filter.businessId)
      .filter(
        (row) =>
          !filter.authorType ||
          (row.currentVersionId &&
            this.versionRows.get(row.currentVersionId)?.authorType === filter.authorType),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .filter(
        (row) =>
          !filter.after ||
          row.createdAt < new Date(filter.after.createdAtKey) ||
          (row.createdAt.getTime() === new Date(filter.after.createdAtKey).getTime() &&
            row.id < filter.after.id),
      )
      .slice(0, filter.limit)
      .map((row) => this.view(row.id) as StoredSite);
  }

  async setSiteStatus(siteId: string, status: StoredSite['status']) {
    const row = this.siteRows.get(siteId);
    if (row) this.siteRows.set(siteId, { ...row, status });
  }

  async insertVersion(version: NewVersion): Promise<StoredVersion> {
    const number =
      Math.max(
        0,
        ...[...this.versionRows.values()]
          .filter((v) => v.siteId === version.siteId)
          .map((v) => v.versionNumber),
      ) + 1;
    const stored: StoredVersion = {
      id: newId(),
      siteId: version.siteId,
      versionNumber: number,
      spec: structuredClone(version.spec),
      specHash: 'f'.repeat(64),
      schemaVersion: version.schemaVersion,
      authorType: version.authorType,
      authorId: version.authorId,
      parentVersionId: version.parentVersionId,
      changeSummary: version.changeSummary,
      issues: version.issues,
      quality: null,
      createdAt: new Date(Date.UTC(2026, 9, 14, 12, 0, this.tick++)),
    };
    this.versionRows.set(stored.id, stored);
    return stored;
  }

  async setCurrentVersion(siteId: string, versionId: string, defaultLocale: string, expected: string | null) {
    const row = this.siteRows.get(siteId);
    if (!row || row.currentVersionId !== expected) return false;
    this.siteRows.set(siteId, { ...row, currentVersionId: versionId, defaultLocale });
    return true;
  }

  async version(siteId: string, versionId: string) {
    const version = this.versionRows.get(versionId);
    return version?.siteId === siteId ? version : undefined;
  }

  async versions(siteId: string, page: { beforeNumber?: number | undefined; limit: number }) {
    return [...this.versionRows.values()]
      .filter((v) => v.siteId === siteId && (!page.beforeNumber || v.versionNumber < page.beforeNumber))
      .sort((a, b) => b.versionNumber - a.versionNumber)
      .slice(0, page.limit)
      .map(({ spec: _spec, ...summary }) => summary);
  }

  async activePublications(siteId: string) {
    return [...this.publications.values()].filter((p) => p.siteId === siteId && p.status === 'active');
  }

  async insertPublication(publication: Parameters<SitesRepository['insertPublication']>[0]) {
    const active = [...this.publications.values()].filter((p) => p.status === 'active');
    if (active.some((p) => p.siteId === publication.siteId && p.environment === publication.environment))
      throw new Error('uq_site_publications__active_environment');
    if (active.some((p) => p.hostname === publication.hostname))
      throw new Error('uq_site_publications__active_hostname');
    const stored: StoredPublication = { id: newId(), status: 'active', endedAt: null, ...publication };
    this.publications.set(stored.id, stored);
    return stored;
  }

  async endPublication(publicationId: string, status: 'expired' | 'unpublished', at: Date) {
    const publication = this.publications.get(publicationId);
    if (publication?.status === 'active')
      this.publications.set(publicationId, { ...publication, status, endedAt: at });
  }

  async setPublicationExpiry(publicationId: string, expiresAt: Date) {
    const publication = this.publications.get(publicationId);
    if (publication) this.publications.set(publicationId, { ...publication, expiresAt });
  }

  async duePreviews(now: Date, limit: number) {
    return [...this.publications.values()]
      .filter(
        (p) => p.status === 'active' && p.environment === 'preview' && p.expiresAt && p.expiresAt <= now,
      )
      .slice(0, limit)
      .map((p) => {
        const site = this.siteRows.get(p.siteId);
        return { ...p, organizationId: site?.organizationId ?? '', businessId: site?.businessId ?? '' };
      });
  }

  private view(siteId: string): StoredSite | undefined {
    const row = this.siteRows.get(siteId);
    if (!row) return undefined;
    const preview = [...this.publications.values()].find(
      (p) => p.siteId === siteId && p.status === 'active' && p.environment === 'preview',
    );
    return {
      ...row,
      businessName: this.businesses.get(row.businessId)?.name ?? '',
      currentVersionNumber: row.currentVersionId
        ? (this.versionRows.get(row.currentVersionId)?.versionNumber ?? null)
        : null,
      preview: preview ? { hostname: preview.hostname, expiresAt: preview.expiresAt } : null,
      createdAtKey: row.createdAt.toISOString().replace('Z', '000Z'),
    };
  }
}

/** A detail without pictures or views (unit tests of the sites themselves). */
export const NO_INSIGHTS: SiteInsights = {
  thumbnails: async () => null,
  views: async () => ({
    last7Days: { pageViews: 0, uniqueEstimate: 0 },
    last30Days: { pageViews: 0, uniqueEstimate: 0 },
  }),
};
