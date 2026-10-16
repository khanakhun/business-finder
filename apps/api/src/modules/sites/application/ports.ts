import type {
  SiteEnvironment,
  SiteIssue,
  SitePublicationStatus,
  SiteStatus,
  SiteVersionAuthor,
} from '@bf/contracts';

// Ports of the sites module (BF-035). Adapters call getExecutor(db), so use cases control transactions.

export interface StoredSite {
  readonly id: string;
  readonly organizationId: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly slug: string;
  readonly name: string;
  readonly status: SiteStatus;
  readonly defaultLocale: string;
  readonly currentVersionId: string | null;
  readonly currentVersionNumber: number | null;
  /** The active preview publication, when there is one. */
  readonly preview: { readonly hostname: string; readonly expiresAt: Date | null } | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StoredVersion {
  readonly id: string;
  readonly siteId: string;
  readonly versionNumber: number;
  readonly spec: Record<string, unknown>;
  readonly specHash: string;
  readonly schemaVersion: number;
  readonly authorType: SiteVersionAuthor;
  readonly authorId: string | null;
  readonly parentVersionId: string | null;
  readonly changeSummary: string | null;
  readonly issues: SiteIssue[];
  readonly quality: Record<string, unknown> | null;
  readonly createdAt: Date;
}

export type StoredVersionSummary = Omit<StoredVersion, 'spec'>;

export interface StoredPublication {
  readonly id: string;
  readonly siteId: string;
  readonly versionId: string;
  readonly environment: SiteEnvironment;
  readonly hostname: string;
  readonly status: SitePublicationStatus;
  readonly publishedBy: string | null;
  readonly publishedAt: Date;
  readonly expiresAt: Date | null;
  readonly endedAt: Date | null;
}

export interface NewVersion {
  readonly siteId: string;
  readonly spec: Record<string, unknown>;
  readonly schemaVersion: number;
  readonly authorType: SiteVersionAuthor;
  readonly authorId: string | null;
  readonly parentVersionId: string | null;
  readonly changeSummary: string | null;
  readonly issues: SiteIssue[];
}

export interface SiteListFilter {
  readonly status?: SiteStatus | undefined;
  readonly businessId?: string | undefined;
  readonly authorType?: SiteVersionAuthor | undefined;
  /** Keyset: sites created before this one (created_at, id). */
  readonly after?: { readonly createdAt: Date; readonly id: string } | undefined;
  readonly limit: number;
}

export interface SitesRepository {
  /** A business the workspace tracks (name and locality for the slug), or undefined. */
  trackedBusiness(
    organizationId: string,
    businessId: string,
  ): Promise<{ id: string; name: string; locality: string | null } | undefined>;
  /** Serializes the creation of a business's site in a workspace (a transaction-scoped advisory lock). */
  lockBusiness(organizationId: string, businessId: string): Promise<void>;
  /** The workspace's (non-archived) site of a business, the oldest first. */
  siteOfBusiness(organizationId: string, businessId: string): Promise<StoredSite | undefined>;
  /** Inserts a site unless its slug is taken (then returns false). */
  insertSite(site: {
    id: string;
    organizationId: string;
    businessId: string;
    slug: string;
    name: string;
    defaultLocale: string;
    createdBy: string | null;
  }): Promise<boolean>;
  site(organizationId: string, siteId: string): Promise<StoredSite | undefined>;
  /** The site, locked for update (edits and publications of a site are serialized). */
  lockSite(organizationId: string, siteId: string): Promise<StoredSite | undefined>;
  sites(organizationId: string, filter: SiteListFilter): Promise<StoredSite[]>;
  setSiteStatus(siteId: string, status: SiteStatus): Promise<void>;
  /** Inserts the next version (number = the site's highest + 1), its hash computed from the spec. */
  insertVersion(version: NewVersion): Promise<StoredVersion>;
  setCurrentVersion(siteId: string, versionId: string, defaultLocale: string): Promise<void>;
  version(siteId: string, versionId: string): Promise<StoredVersion | undefined>;
  versions(
    siteId: string,
    page: { readonly beforeNumber?: number | undefined; readonly limit: number },
  ): Promise<StoredVersionSummary[]>;
  activePublications(siteId: string): Promise<StoredPublication[]>;
  insertPublication(publication: {
    siteId: string;
    versionId: string;
    environment: SiteEnvironment;
    hostname: string;
    publishedBy: string | null;
    publishedAt: Date;
    expiresAt: Date | null;
  }): Promise<StoredPublication>;
  endPublication(publicationId: string, status: 'expired' | 'unpublished', at: Date): Promise<void>;
  setPublicationExpiry(publicationId: string, expiresAt: Date): Promise<void>;
  /** Active previews whose expiry has passed, with their site's workspace and business (oldest first). */
  duePreviews(
    now: Date,
    limit: number,
  ): Promise<(StoredPublication & { organizationId: string; businessId: string })[]>;
}
export const SITES_REPOSITORY = Symbol('SitesRepository');

/** Asks the renderer to refresh pages (a job: retried while the renderer is down). */
export interface SiteRevalidation {
  revalidate(input: {
    organizationId: string;
    siteId: string;
    tags: string[];
    idempotencyKey: string;
  }): Promise<void>;
}
export const SITE_REVALIDATION = Symbol('SiteRevalidation');

/** The platform's site settings: where previews are served and which host serves site images. */
export interface SiteHosting {
  readonly baseDomain: string;
  readonly assetHosts: readonly string[];
}
export const SITE_HOSTING = Symbol('SiteHosting');
