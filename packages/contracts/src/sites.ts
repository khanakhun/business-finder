import { z } from 'zod';
import { defineEvent } from './events.ts';
import { BusinessId, SiteId } from './ids.ts';
import { defineJob } from './jobs.ts';
import { CursorPageRequestSchema, cursorPage } from './pagination.ts';

// Sites (BF-035): a workspace's preview website of a business, its immutable versions (SiteSpec documents, BF-033)
// and its publications (a hostname serving a version, with an expiry). The spec itself is validated by
// @bf/site-schema in the API; here it is an opaque JSON document (this package imports nothing internal).

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

/** A problem the SiteSpec validators found (errors block a version; warnings are stored with it). */
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
    /** Warnings the validator left (errors never reach a version). */
    warnings: z.number().int().nonnegative(),
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

export const SiteDetailSchema = SiteSummarySchema.extend({
  currentVersionSummary: SiteVersionSummarySchema.nullable(),
  /** Active publications (one per environment at most). */
  publications: z.array(SitePublicationSchema),
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
