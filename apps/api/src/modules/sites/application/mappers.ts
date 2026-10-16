import type {
  BusinessId,
  SiteDetail,
  SiteId,
  SitePublication,
  SiteSummary,
  SiteVersion,
  SiteVersionSummary,
} from '@bf/contracts';
import type {
  StoredPublication,
  StoredSite,
  StoredThumbnails,
  StoredVersion,
  StoredVersionSummary,
} from './ports.ts';

/** Previews are served over https at their hostname (BF-036). */
export const publicationUrl = (hostname: string) => `https://${hostname}/`;

export const toSiteSummary = (site: StoredSite): SiteSummary => ({
  id: site.id as SiteId,
  businessId: site.businessId as BusinessId,
  businessName: site.businessName,
  slug: site.slug,
  name: site.name,
  status: site.status,
  defaultLocale: site.defaultLocale,
  currentVersion:
    site.currentVersionId && site.currentVersionNumber
      ? { id: site.currentVersionId, versionNumber: site.currentVersionNumber }
      : null,
  preview: site.preview
    ? { url: publicationUrl(site.preview.hostname), expiresAt: site.preview.expiresAt?.toISOString() ?? null }
    : null,
  createdBy: site.createdBy,
  createdAt: site.createdAt.toISOString(),
  updatedAt: site.updatedAt.toISOString(),
});

export const toVersionSummary = (version: StoredVersionSummary): SiteVersionSummary => ({
  id: version.id,
  siteId: version.siteId as SiteId,
  versionNumber: version.versionNumber,
  authorType: version.authorType,
  authorId: version.authorId,
  parentVersionId: version.parentVersionId,
  changeSummary: version.changeSummary,
  specHash: version.specHash,
  schemaVersion: version.schemaVersion,
  warnings: version.issues.filter((issue) => issue.severity === 'warning').length,
  createdAt: version.createdAt.toISOString(),
});

export const toVersion = (version: StoredVersion): SiteVersion => ({
  ...toVersionSummary(version),
  spec: version.spec,
  issues: version.issues,
  quality: version.quality,
});

export const toPublication = (publication: StoredPublication): SitePublication => ({
  id: publication.id,
  versionId: publication.versionId,
  environment: publication.environment,
  hostname: publication.hostname,
  url: publicationUrl(publication.hostname),
  status: publication.status,
  publishedBy: publication.publishedBy,
  publishedAt: publication.publishedAt.toISOString(),
  expiresAt: publication.expiresAt?.toISOString() ?? null,
  endedAt: publication.endedAt?.toISOString() ?? null,
});

export const toSiteDetail = (
  site: StoredSite,
  current: StoredVersionSummary | undefined,
  publications: readonly StoredPublication[],
  insights: { thumbnails: StoredThumbnails | null; views: SiteDetail['views'] },
): SiteDetail => ({
  ...toSiteSummary(site),
  currentVersionSummary: current ? toVersionSummary(current) : null,
  publications: publications.map(toPublication),
  thumbnails: insights.thumbnails
    ? {
        publicationId: insights.thumbnails.publicationId,
        takenAt: insights.thumbnails.takenAt,
        desktop: insights.thumbnails.desktopKey !== null,
        mobile: insights.thumbnails.mobileKey !== null,
      }
    : null,
  views: insights.views,
});
