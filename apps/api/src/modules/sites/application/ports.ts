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
  /** `created_at` to the microsecond (ISO, UTC): the list's keyset position (a Date keeps only milliseconds). */
  readonly createdAtKey: string;
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
  /** Keyset: sites created before this one (`createdAtKey`, id). */
  readonly after?: { readonly createdAtKey: string; readonly id: string } | undefined;
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
  /** The workspace's sites of a business that are not archived, the oldest first. */
  sitesOfBusiness(organizationId: string, businessId: string): Promise<StoredSite[]>;
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
  /** The site, locked (`FOR NO KEY UPDATE`: edits and publications of a site are serialized). */
  lockSite(organizationId: string, siteId: string): Promise<StoredSite | undefined>;
  sites(organizationId: string, filter: SiteListFilter): Promise<StoredSite[]>;
  setSiteStatus(siteId: string, status: SiteStatus): Promise<void>;
  /** Inserts the next version (number = the site's highest + 1), its hash computed from the spec. */
  insertVersion(version: NewVersion): Promise<StoredVersion>;
  /** Moves the current version if it is still `expected` (compare-and-set); false when it moved meanwhile. */
  setCurrentVersion(
    siteId: string,
    versionId: string,
    defaultLocale: string,
    expected: string | null,
  ): Promise<boolean>;
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

// ── Views (part 2) ──────────────────────────────────────────────────────────────────────────────────────────────

export interface DayViews {
  readonly siteId: string;
  readonly day: string;
  readonly pageViews: number;
  readonly uniqueEstimate: number;
  readonly byLocale: Record<string, number>;
  readonly byCampaign: Record<string, number>;
}

/** Where views are counted until they are flushed (Valkey). */
export interface SiteViewCounter {
  /** The day's random salt of visitor hashes (created on first use, gone after two days: never stored elsewhere). */
  dailySalt(day: string): Promise<string>;
  /**
   * Counts a view, atomically; false when the visitor already sent the most views a day counts for that site. A
   * campaign beyond the first `MAX_CAMPAIGNS` of the day is counted as `~other`.
   */
  record(view: {
    siteId: string;
    day: string;
    hour: string;
    /** A daily-salted hash of the visitor's network address (never an IP or a user agent). */
    visitor: string;
    locale: string;
    campaign?: string | undefined;
  }): Promise<boolean>;
  /** (day, site) pairs with views not yet written, with their totals and a version that changes with each view. */
  pendingDays(limit: number): Promise<(DayViews & { readonly version: string })[]>;
  /** Marks pairs written, unless a view arrived since they were read (their version moved: the next flush). */
  clearDays(views: readonly { siteId: string; day: string; version: string }[]): Promise<void>;
  completedHours(
    beforeHour: string,
    limit: number,
  ): Promise<{ siteId: string; hour: string; pageViews: number; uniqueEstimate: number }[]>;
  forgetHour(siteId: string, hour: string): Promise<void>;
}
export const SITE_VIEW_COUNTER = Symbol('SiteViewCounter');

/** The views store of the database (site_view_daily) and what view analytics need from sites. */
export interface SiteViewsRepository {
  /** Writes the days' totals (absolute) for sites that still exist; returns how many rows it wrote. */
  upsertDays(views: readonly DayViews[]): Promise<number>;
  /** Page views and unique estimates from `fromDay` (inclusive). */
  totals(siteId: string, fromDay: string): Promise<{ pageViews: number; uniqueEstimate: number }>;
  /** The workspace and business of sites (those that exist). */
  refs(siteIds: readonly string[]): Promise<{ id: string; organizationId: string; businessId: string }[]>;
  /** Claims a site's hour for its `site.viewed` event; false when it was already claimed (one event per hour). */
  claimHour(siteId: string, hourStart: string): Promise<boolean>;
  /** Forgets claims of hours before `before` (their counters are gone from Valkey); returns how many. */
  pruneHours(before: string, limit: number): Promise<number>;
}
export const SITE_VIEWS_REPOSITORY = Symbol('SiteViewsRepository');

/** The secret shared with the renderer (view tokens, daily salts); undefined when views are not configured. */
export const SITE_VIEW_SECRET = Symbol('SiteViewSecret');

// ── Assets (part 2) ─────────────────────────────────────────────────────────────────────────────────────────────

export interface StoredAsset {
  readonly id: string;
  readonly organizationId: string;
  readonly siteId: string | null;
  readonly storageKey: string;
  readonly status: 'pending' | 'processing' | 'ready' | 'failed';
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly bytes: number | null;
  readonly publicUrl: string | null;
  readonly variants: { width: number; format: string; key: string; url: string; bytes: number }[] | null;
  readonly license: 'owner_site' | 'stock' | 'ai_generated' | 'uploaded';
  readonly licenseDetails: Record<string, string> | null;
  readonly alt: Record<string, string> | null;
  readonly dominantColors: string[] | null;
  /** The SHA-256 of the original as checked at finalize (the job processes those bytes only). */
  readonly sha256: string | null;
  /** When processing started (null outside `processing`). */
  readonly processingStartedAt: Date | null;
  readonly createdAt: Date;
}

export type AssetStatus = StoredAsset['status'];

export interface SiteAssetsRepository {
  insert(
    asset: Omit<
      StoredAsset,
      | 'status'
      | 'width'
      | 'height'
      | 'publicUrl'
      | 'variants'
      | 'dominantColors'
      | 'sha256'
      | 'processingStartedAt'
      | 'createdAt'
    > & {
      createdBy: string | null;
    },
  ): Promise<StoredAsset>;
  get(organizationId: string, siteId: string, assetId: string): Promise<StoredAsset | undefined>;
  /** By id only (the processing job). */
  byId(assetId: string): Promise<StoredAsset | undefined>;
  /** The asset, its row locked until the transaction ends (a delete reads its current state, not a stale one). */
  lock(organizationId: string, siteId: string, assetId: string): Promise<StoredAsset | undefined>;
  /** Marks failed the assets processing since before `before` (a job that died); returns them. */
  failStale(before: Date, limit: number): Promise<StoredAsset[]>;
  list(organizationId: string, siteId: string): Promise<StoredAsset[]>;
  /**
   * Applies the changes only while the asset is in one of `from` (compare-and-set: two finalizes, a late job or a
   * deletion never overwrite each other); returns whether it did.
   */
  transition(
    assetId: string,
    from: readonly AssetStatus[],
    changes: Partial<Omit<StoredAsset, 'id' | 'organizationId' | 'siteId' | 'storageKey' | 'createdAt'>>,
  ): Promise<boolean>;
  /** Whether a version of the site names the asset (its id or one of its URLs). */
  referenced(siteId: string, needles: readonly string[]): Promise<boolean>;
  delete(assetId: string): Promise<void>;
}
export const SITE_ASSETS_REPOSITORY = Symbol('SiteAssetsRepository');

/** The private bucket of uploaded originals (`ObjectStorage` on the assets bucket); the worker needs it too. */
export const SITE_ORIGINALS = Symbol('SiteOriginals');
/** The artifacts bucket, read-only: the screenshots services/intel took of published sites. */
export const SITE_ARTIFACTS = Symbol('SiteArtifacts');

/** Presigned uploads to the private originals bucket. */
export interface UploadSigner {
  presignPut(
    key: string,
    contentType: string,
    bytes: number,
    expiresInSeconds: number,
  ): Promise<{ url: string; headers: Record<string, string> }>;
}
export const UPLOAD_SIGNER = Symbol('UploadSigner');

/** The public bucket behind the CDN (`SITES_ASSETS_BASE_URL`): processed variants only. */
export interface PublicFiles {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  url(key: string): string;
}
export const PUBLIC_FILES = Symbol('PublicFiles');

/** Image decoding and re-encoding (sharp). */
export interface ImageProcessor {
  /** Oriented dimensions; throws for an image it cannot read or a format outside `DECODABLE_FORMATS`. */
  inspect(image: Buffer): Promise<{ width: number; height: number }>;
  /** Oriented, metadata stripped, resized (never enlarged) and re-encoded. */
  variants(
    image: Buffer,
    widths: readonly number[],
  ): Promise<{ width: number; format: 'webp' | 'avif'; body: Buffer }[]>;
  dominantColors(image: Buffer, count: number): Promise<string[]>;
}
export const IMAGE_PROCESSOR = Symbol('ImageProcessor');

/** Queues the processing of a finalized asset. */
export interface AssetProcessingQueue {
  process(assetId: string, organizationId: string): Promise<void>;
}
export const ASSET_PROCESSING_QUEUE = Symbol('AssetProcessingQueue');

// ── Screenshots and the detail's insights (part 2) ──────────────────────────────────────────────────────────────

export interface StoredThumbnails {
  readonly publicationId: string;
  readonly takenAt: string;
  readonly desktopKey: string | null;
  readonly mobileKey: string | null;
}

export interface SiteThumbnailsRepository {
  /** A publication of the site, with the workspace (the screenshot job checks it is still active). */
  publication(
    siteId: string,
    publicationId: string,
  ): Promise<{ organizationId: string; hostname: string; status: StoredPublication['status'] } | undefined>;
  get(siteId: string): Promise<StoredThumbnails | null>;
  /** Stores the pictures while their publication is still active (one statement); returns whether it did. */
  setIfActive(siteId: string, thumbnails: StoredThumbnails): Promise<boolean>;
}
export const SITE_THUMBNAILS_REPOSITORY = Symbol('SiteThumbnailsRepository');

/** Desktop and mobile pictures of a page (services/intel's browser), stored under the prefix in the artifacts bucket. */
export interface SiteScreenshotter {
  capture(
    url: string,
    artifactPrefix: string,
    signal: AbortSignal,
  ): Promise<{ desktopKey: string | null; mobileKey: string | null }>;
}
export const SITE_SCREENSHOTTER = Symbol('SiteScreenshotter');

export interface SiteScreenshotQueue {
  capture(input: {
    organizationId: string;
    siteId: string;
    publicationId: string;
    idempotencyKey: string;
  }): Promise<void>;
}
export const SITE_SCREENSHOT_QUEUE = Symbol('SiteScreenshotQueue');

/** What a site's detail shows beside the site itself: its pictures and its views. */
export interface SiteInsights {
  thumbnails(siteId: string): Promise<StoredThumbnails | null>;
  views(siteId: string): Promise<{
    last7Days: { pageViews: number; uniqueEstimate: number };
    last30Days: { pageViews: number; uniqueEstimate: number };
  }>;
}
export const SITE_INSIGHTS = Symbol('SiteInsights');
