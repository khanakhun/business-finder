import { z } from 'zod';
import { constantTimeEqual, fromBase64Url, hmacSha256, toBase64Url } from './encoding.ts';
import { defineEvent } from './events.ts';
import { BusinessId, SiteId } from './ids.ts';
import { defineJob } from './jobs.ts';
import { CursorPageRequestSchema, cursorPage } from './pagination.ts';

// Sites (BF-035): a workspace's preview website of a business, its immutable versions (SiteSpec documents, BF-033)
// and its publications (a hostname serving a version, with an expiry). The spec itself is validated by
// @bf/site-schema in the API; here it is an opaque JSON document (this package imports nothing internal).

/** The largest spec a site version holds, in UTF-8 bytes of its JSON (a full 8-page site is under 300 kB). */
export const SITE_SPEC_MAX_BYTES = 750_000;

export const SITE_STATUSES = ['draft', 'preview', 'live', 'archived'] as const;
export const SiteStatusSchema = z.enum(SITE_STATUSES);
export type SiteStatus = z.infer<typeof SiteStatusSchema>;

/** Who made a version: a person in the editor, a generation job, a chat edit, an import or a rollback. */
export const SITE_VERSION_AUTHORS = ['user', 'generation_job', 'chat_edit', 'import', 'rollback'] as const;
export const SiteVersionAuthorSchema = z.enum(SITE_VERSION_AUTHORS);
export type SiteVersionAuthor = z.infer<typeof SiteVersionAuthorSchema>;

export const SITE_ENVIRONMENTS = ['preview', 'live'] as const;
export const SiteEnvironmentSchema = z.enum(SITE_ENVIRONMENTS);
export type SiteEnvironment = z.infer<typeof SiteEnvironmentSchema>;

export const SITE_PUBLICATION_STATUSES = ['active', 'expired', 'unpublished'] as const;
export const SitePublicationStatusSchema = z.enum(SITE_PUBLICATION_STATUSES);
export type SitePublicationStatus = z.infer<typeof SitePublicationStatusSchema>;

/** A SiteSpec v1 document (JSON Schema: packages/site-schema/generated/site-spec.schema.json). */
export const SiteSpecDocumentSchema = z
  .record(z.string(), z.unknown())
  .meta({ id: 'SiteSpecDocument', description: 'A SiteSpec v1 document, validated by @bf/site-schema.' });
export type SiteSpecDocument = z.infer<typeof SiteSpecDocumentSchema>;

/** A problem the SiteSpec validators found (stored with the version; errors block publishing). */
export const SiteIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    code: z.string().max(60),
    severity: z.enum(['error', 'warning']),
    message: z.string().max(500),
  })
  .meta({ id: 'SiteIssue' });
export type SiteIssue = z.infer<typeof SiteIssueSchema>;

export const SiteVersionSummarySchema = z
  .object({
    id: z.uuid(),
    siteId: SiteId,
    versionNumber: z.number().int().positive(),
    authorType: SiteVersionAuthorSchema,
    authorId: z.string().nullable(),
    parentVersionId: z.uuid().nullable(),
    changeSummary: z.string().nullable(),
    specHash: z.string(),
    schemaVersion: z.number().int().positive(),
    /** Warnings the validator left. */
    warnings: z.number().int().nonnegative(),
    /** Errors of content still being written (a missing translation, low contrast…): the version cannot be published. */
    errors: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SiteVersionSummary' });
export type SiteVersionSummary = z.infer<typeof SiteVersionSummarySchema>;

export const SiteVersionSchema = SiteVersionSummarySchema.extend({
  spec: SiteSpecDocumentSchema,
  issues: z.array(SiteIssueSchema),
  /** The quality gates' report (BF-045), once computed. */
  quality: z.record(z.string(), z.unknown()).nullable(),
}).meta({ id: 'SiteVersion' });
export type SiteVersion = z.infer<typeof SiteVersionSchema>;

export const SitePublicationSchema = z
  .object({
    id: z.uuid(),
    versionId: z.uuid(),
    environment: SiteEnvironmentSchema,
    hostname: z.string(),
    url: z.url(),
    status: SitePublicationStatusSchema,
    publishedBy: z.string().nullable(),
    publishedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'SitePublication' });
export type SitePublication = z.infer<typeof SitePublicationSchema>;

export const SiteSummarySchema = z
  .object({
    id: SiteId,
    businessId: BusinessId,
    businessName: z.string(),
    slug: z.string(),
    name: z.string(),
    status: SiteStatusSchema,
    defaultLocale: z.string(),
    currentVersion: z.object({ id: z.uuid(), versionNumber: z.number().int().positive() }).nullable(),
    /** The active preview, when there is one. */
    preview: z.object({ url: z.url(), expiresAt: z.iso.datetime().nullable() }).nullable(),
    createdBy: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'SiteSummary' });
export type SiteSummary = z.infer<typeof SiteSummarySchema>;

/** Desktop and mobile pictures of a site's published home page (for cards), when taken. */
export const SiteThumbnailsSchema = z
  .object({
    publicationId: z.uuid(),
    takenAt: z.iso.datetime(),
    desktop: z.boolean(),
    mobile: z.boolean(),
  })
  .meta({ id: 'SiteThumbnails' });
export type SiteThumbnails = z.infer<typeof SiteThumbnailsSchema>;

/** A site's views over recent days (unique visitors are an estimate; no IP or user agent is ever stored). */
export const SiteViewStatsSchema = z
  .object({
    last7Days: z.object({
      pageViews: z.number().int().nonnegative(),
      uniqueEstimate: z.number().int().nonnegative(),
    }),
    last30Days: z.object({
      pageViews: z.number().int().nonnegative(),
      uniqueEstimate: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: 'SiteViewStats' });
export type SiteViewStats = z.infer<typeof SiteViewStatsSchema>;

export const SiteDetailSchema = SiteSummarySchema.extend({
  currentVersionSummary: SiteVersionSummarySchema.nullable(),
  /** Active publications (one per environment at most). */
  publications: z.array(SitePublicationSchema),
  /** Desktop and mobile pictures of the published home page, when taken. */
  thumbnails: SiteThumbnailsSchema.nullable(),
  views: SiteViewStatsSchema,
}).meta({ id: 'SiteDetail' });
export type SiteDetail = z.infer<typeof SiteDetailSchema>;

export const SitePageSchema = cursorPage(SiteSummarySchema).meta({ id: 'SitePage' });
export type SitePage = z.infer<typeof SitePageSchema>;
export const SiteVersionPageSchema = cursorPage(SiteVersionSummarySchema).meta({ id: 'SiteVersionPage' });
export type SiteVersionPage = z.infer<typeof SiteVersionPageSchema>;

export const SiteListQuerySchema = CursorPageRequestSchema.extend({
  status: SiteStatusSchema.optional(),
  businessId: BusinessId.optional(),
  /** Sites whose current version was made by this kind of author (e.g. `generation_job`). */
  authorType: SiteVersionAuthorSchema.optional(),
}).meta({ id: 'SiteListQuery' });
export type SiteListQuery = z.infer<typeof SiteListQuerySchema>;

const changeSummary = z.string().trim().min(1).max(300);

export const CreateSiteRequestSchema = z
  .object({
    businessId: BusinessId,
    /** A first version; without one the site is a draft with no version. */
    spec: SiteSpecDocumentSchema.optional(),
    /** Another site for a business that already has one (by default its existing site is returned). */
    forceNew: z.boolean().optional(),
  })
  .meta({ id: 'CreateSiteRequest' });
export type CreateSiteRequest = z.infer<typeof CreateSiteRequestSchema>;

export const CreateSiteVersionRequestSchema = z
  .object({
    spec: SiteSpecDocumentSchema,
    /** The version the edit started from (null for a site's first version): a different current version is a conflict. */
    baseVersionId: z.uuid().nullable(),
    changeSummary: changeSummary.optional(),
  })
  .meta({ id: 'CreateSiteVersionRequest' });
export type CreateSiteVersionRequest = z.infer<typeof CreateSiteVersionRequestSchema>;

export const ApplySiteOperationsRequestSchema = z
  .object({
    /** SiteSpec operations (@bf/site-schema `OperationSchema`), applied atomically. */
    operations: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
    baseVersionId: z.uuid(),
    changeSummary: changeSummary.optional(),
  })
  .meta({ id: 'ApplySiteOperationsRequest' });
export type ApplySiteOperationsRequest = z.infer<typeof ApplySiteOperationsRequestSchema>;

export const PublishPreviewRequestSchema = z
  .object({
    versionId: z.uuid(),
    expiresInDays: z.number().int().min(1).max(90).default(30),
  })
  .meta({ id: 'PublishPreviewRequest' });
export type PublishPreviewRequest = z.infer<typeof PublishPreviewRequestSchema>;

export const ExtendPreviewRequestSchema = z
  .object({ days: z.number().int().min(1).max(90) })
  .meta({ id: 'ExtendPreviewRequest' });
export type ExtendPreviewRequest = z.infer<typeof ExtendPreviewRequestSchema>;

export const UnpublishSiteRequestSchema = z
  .object({ environment: SiteEnvironmentSchema })
  .meta({ id: 'UnpublishSiteRequest' });
export type UnpublishSiteRequest = z.infer<typeof UnpublishSiteRequestSchema>;

export const RollbackSiteRequestSchema = z
  .object({
    /** The version whose content becomes current again (as a new version). */
    versionId: z.uuid(),
    baseVersionId: z.uuid(),
  })
  .meta({ id: 'RollbackSiteRequest' });
export type RollbackSiteRequest = z.infer<typeof RollbackSiteRequestSchema>;

export const SiteDiffQuerySchema = z.object({ from: z.uuid(), to: z.uuid() }).meta({ id: 'SiteDiffQuery' });
export type SiteDiffQuery = z.infer<typeof SiteDiffQuerySchema>;

const blockRef = z.object({ pageId: z.string(), blockId: z.string(), type: z.string() });

/** What changed between two versions, structurally, for people (history, review before publishing). */
export const SiteVersionDiffSchema = z
  .object({
    from: z.uuid(),
    to: z.uuid(),
    /** One line, e.g. "1 page added, 3 blocks changed, 5 texts edited". */
    summary: z.string(),
    pages: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
    blocks: z.object({
      added: z.array(blockRef),
      removed: z.array(blockRef),
      moved: z.array(
        blockRef.extend({ fromPageId: z.string(), fromIndex: z.number().int(), toIndex: z.number().int() }),
      ),
      changed: z.array(blockRef.extend({ fields: z.array(z.string()) })),
    }),
    texts: z.array(
      z.object({
        path: z.array(z.union([z.string(), z.number()])),
        locale: z.string(),
        before: z.string().nullable(),
        after: z.string().nullable(),
      }),
    ),
    /** Site-wide parts that changed: theme, contact, layout, navigation, seo, settings, assets, brand, locales. */
    sections: z.array(z.string()),
  })
  .meta({ id: 'SiteVersionDiff' });
export type SiteVersionDiff = z.infer<typeof SiteVersionDiffSchema>;

/**
 * What the API asks the site renderer (BF-036) to refresh after a publication changed: its cache tags
 * (`site:<id>`, `host:<hostname>`). Sent as `POST <SITES_INTERNAL_URL>/api/revalidate`, signed like internal calls.
 */
export const SiteRevalidateRequestSchema = z
  .object({
    tags: z
      .array(z.string().regex(/^(site|host):[a-z0-9.-]{1,253}$/))
      .min(1)
      .max(20),
  })
  .meta({ id: 'SiteRevalidateRequest' });
export type SiteRevalidateRequest = z.infer<typeof SiteRevalidateRequestSchema>;

const sitePayload = { siteId: SiteId, businessId: BusinessId };

export const SiteCreated = defineEvent('site.created', 1, z.object({ ...sitePayload, slug: z.string() }));

export const SiteVersionCreated = defineEvent(
  'site.version.created',
  1,
  z.object({
    ...sitePayload,
    versionId: z.uuid(),
    versionNumber: z.number().int().positive(),
    authorType: SiteVersionAuthorSchema,
    parentVersionId: z.uuid().nullable(),
  }),
);

const publicationPayload = z.object({
  ...sitePayload,
  publicationId: z.uuid(),
  versionId: z.uuid(),
  environment: SiteEnvironmentSchema,
  hostname: z.string(),
});

export const SitePublished = defineEvent(
  'site.published',
  1,
  publicationPayload.extend({ expiresAt: z.iso.datetime().nullable() }),
);
export const SiteUnpublished = defineEvent('site.unpublished', 1, publicationPayload);
export const SiteExpired = defineEvent('site.expired', 1, publicationPayload);
export const SiteArchived = defineEvent('site.archived', 1, z.object(sitePayload));
export const SitePreviewExtended = defineEvent(
  'site.preview.extended',
  1,
  publicationPayload.extend({ expiresAt: z.iso.datetime() }),
);

/** The events after which the renderer must refresh a site's pages (BF-036 revalidation). */
export const SITE_RENDER_EVENTS = [SitePublished, SiteUnpublished, SiteExpired, SitePreviewExtended] as const;

/** Asks the renderer to refresh a site's pages (after a publication changed). */
export const SitesRevalidateJob = defineJob('sites-revalidate', 'revalidate', {
  siteId: SiteId,
  tags: SiteRevalidateRequestSchema.shape.tags,
});

/** Ends the active previews whose expiry has passed (enqueued hourly, one job per hour). */
export const SitesExpireJob = defineJob('sites-expire', 'expire', {});

// ── Part 2: assets, screenshots, views ────────────────────────────────────────────────────────────────────────

export const SITE_ASSET_LICENSES = ['owner_site', 'stock', 'ai_generated', 'uploaded'] as const;
export const SiteAssetLicenseSchema = z.enum(SITE_ASSET_LICENSES);
export const SITE_ASSET_STATUSES = ['pending', 'processing', 'ready', 'failed'] as const;
/** Image types a site accepts (sniffed from the bytes at finalize, not trusted from the request). */
export const SITE_ASSET_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;
export const SITE_ASSET_MAX_BYTES = 15 * 1024 * 1024;

const localizedAlt = z.record(z.string().regex(/^[a-z]{2}$/), z.string().trim().min(1).max(150));

export const SiteAssetSchema = z
  .object({
    id: z.uuid(),
    siteId: SiteId.nullable(),
    status: z.enum(SITE_ASSET_STATUSES),
    mime: z.string(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    bytes: z.number().int().nonnegative().nullable(),
    /** The public URL of its default variant (1200 px WebP, or smaller for small images), once processed. */
    publicUrl: z.url().nullable(),
    variants: z.array(
      z.object({ width: z.number().int().positive(), format: z.enum(['webp', 'avif']), url: z.url() }),
    ),
    license: SiteAssetLicenseSchema,
    licenseDetails: z.record(z.string(), z.string()).nullable(),
    alt: localizedAlt.nullable(),
    dominantColors: z.array(z.string().regex(/^#[0-9a-f]{6}$/)).nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SiteAsset' });
export type SiteAsset = z.infer<typeof SiteAssetSchema>;

export const SiteAssetListSchema = z
  .object({ items: z.array(SiteAssetSchema) })
  .meta({ id: 'SiteAssetList' });
export type SiteAssetList = z.infer<typeof SiteAssetListSchema>;

export const CreateSiteAssetUploadRequestSchema = z
  .object({
    mime: z.enum(SITE_ASSET_MIME_TYPES),
    bytes: z.number().int().min(1).max(SITE_ASSET_MAX_BYTES),
    /** Where the image comes from: required (BF-038 licensing). */
    license: SiteAssetLicenseSchema,
    licenseDetails: z
      .object({
        author: z.string().trim().max(120).optional(),
        sourceUrl: z.url().max(500).optional(),
        attributionText: z.string().trim().max(200).optional(),
        provider: z.string().trim().max(60).optional(),
      })
      .strict()
      .optional(),
    alt: localizedAlt.optional(),
  })
  .meta({ id: 'CreateSiteAssetUploadRequest' });
export type CreateSiteAssetUploadRequest = z.infer<typeof CreateSiteAssetUploadRequestSchema>;

export const SiteAssetUploadSchema = z
  .object({
    asset: SiteAssetSchema,
    /** A presigned URL: PUT the bytes there with these headers before it expires, then finalize. */
    uploadUrl: z.url(),
    method: z.literal('PUT'),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'SiteAssetUpload' });
export type SiteAssetUpload = z.infer<typeof SiteAssetUploadSchema>;

/** A page view sent by the renderer's beacon (anonymous): the site's token, the page, its language, a campaign. */
export const SiteViewBeaconSchema = z
  .object({
    token: z.string().min(10).max(200),
    pageId: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
    locale: z.string().regex(/^[a-z]{2}$/),
    /** The outreach campaign reference (`?c=` of the link in an e-mail), when present. */
    c: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
  })
  .meta({ id: 'SiteViewBeacon' });
export type SiteViewBeacon = z.infer<typeof SiteViewBeaconSchema>;

const VIEW_TOKEN_PREFIX = 'v1';

/**
 * The token a published page carries for its view beacon (BF-036 signs it, the API verifies it):
 * `v1.<siteId>.<base64url(hmac_sha256(secret, "site-view:" + siteId))>`. It names the site, so a beacon cannot count
 * views for another one; it is not a secret from visitors.
 */
export async function signSiteViewToken(siteId: string, secret: string): Promise<string> {
  const mac = await hmacSha256(secret, `site-view:${siteId}`);
  return `${VIEW_TOKEN_PREFIX}.${siteId}.${toBase64Url(mac)}`;
}

/** The site a view token names, when its signature is valid. */
export async function verifySiteViewToken(token: string, secret: string): Promise<string | undefined> {
  const [prefix, siteId, signature, ...rest] = token.split('.');
  if (prefix !== VIEW_TOKEN_PREFIX || !siteId || !signature || rest.length > 0) return undefined;
  if (!SiteId.safeParse(siteId).success) return undefined;
  const given = fromBase64Url(signature);
  if (!given) return undefined;
  return constantTimeEqual(given, await hmacSha256(secret, `site-view:${siteId}`)) ? siteId : undefined;
}

/** Views of a site during one UTC hour, aggregated (scoring's engagement feature, analytics). */
export const SiteViewed = defineEvent(
  'site.viewed',
  1,
  z.object({
    ...sitePayload,
    hourStart: z.iso.datetime(),
    pageViews: z.number().int().positive(),
    uniqueEstimate: z.number().int().nonnegative(),
  }),
);

/** Strips, resizes and re-encodes an uploaded image into its public variants. */
export const SitesAssetProcessJob = defineJob('sites-asset-process', 'process', { assetId: z.uuid() });

/** Takes desktop and mobile pictures of a newly published site (for the dashboard's cards). */
export const SitesScreenshotJob = defineJob('sites-screenshot', 'capture', {
  siteId: SiteId,
  publicationId: z.uuid(),
});

/** Writes the views counted in Valkey to the database, and the hourly `site.viewed` events (every 5 minutes). */
export const SitesViewsFlushJob = defineJob('sites-views', 'flush', {});
