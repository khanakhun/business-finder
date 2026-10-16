import {
  type Clock,
  NotFoundError,
  newId,
  SiteArchived,
  SiteCreated,
  type SiteEnvironment,
  SiteExpired,
  type SiteIssue,
  SitePublished,
  SiteUnpublished,
  type SiteVersionAuthor,
  SiteVersionCreated,
  ValidationError,
} from '@bf/contracts';
import { afterCommit, type DbClient } from '@bf/db';
import { apply, migrateSpec, OperationError, OperationSchema, type SiteSpec } from '@bf/site-schema';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import { NoActivePublicationError, SiteArchivedError, SiteVersionConflictError } from '../domain/errors.ts';
import { extendedExpiry, previewExpiry, previewHostname, siteStatus } from '../domain/publication-policy.ts';
import { baseSlug, slugCandidate } from '../domain/slug.ts';
import { diffSpecs } from '../domain/version-diff.ts';
import {
  SITE_HOSTING,
  SITE_REVALIDATION,
  SITES_REPOSITORY,
  type SiteHosting,
  type SiteRevalidation,
  type SitesRepository,
  type StoredPublication,
  type StoredSite,
  type StoredVersion,
} from './ports.ts';
import { checkSpec } from './spec-check.ts';

/** Who acts: the workspace (always from the authenticated context) and the user, when a person. */
export interface SiteActor {
  readonly organizationId: string;
  readonly userId: string | null;
}

/** Who made a version, when not the acting user (a generation job, a chat edit, an import). */
export interface VersionAuthor {
  readonly type: SiteVersionAuthor;
  readonly id: string | null;
}

/** How many slug candidates are tried before giving up (`salon-gustavia`, `-2`, … `-50`). */
const SLUG_ATTEMPTS = 50;

/**
 * The site edits and publications (BF-035). Every change of a site happens with its row locked, so two edits are
 * serialized, and an edit from a stale version is a conflict (optimistic concurrency on the current version).
 */
@Injectable()
export class SiteCommands {
  constructor(
    @Inject(SITES_REPOSITORY) private readonly repository: SitesRepository,
    @Inject(SITE_REVALIDATION) private readonly revalidation: SiteRevalidation,
    @Inject(SITE_HOSTING) private readonly hosting: SiteHosting,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DB_CLIENT) private readonly db: DbClient,
    private readonly events: EventRecorder,
  ) {}

  /**
   * The business's site in the workspace: created (with a first version when a spec is given), or the existing one
   * unless `forceNew`. Returns whether it was created.
   */
  @Transactional()
  async create(
    actor: SiteActor,
    input: { businessId: string; spec?: Record<string, unknown> | undefined; forceNew?: boolean | undefined },
  ): Promise<{ siteId: string; created: boolean }> {
    const business = await this.repository.trackedBusiness(actor.organizationId, input.businessId);
    if (!business) throw new NotFoundError('Business', input.businessId);
    // Checked before anything is written: an invalid first version creates no site.
    const first = input.spec ? checkSpec(input.spec, this.hosting) : undefined;
    await this.repository.lockBusiness(actor.organizationId, business.id);
    if (!input.forceNew) {
      const existing = await this.repository.siteOfBusiness(actor.organizationId, business.id);
      if (existing) return { siteId: existing.id, created: false };
    }
    const base = baseSlug(business.name, business.locality);
    const siteId = newId();
    let slug: string | undefined;
    for (let n = 1; n <= SLUG_ATTEMPTS && !slug; n += 1) {
      const candidate = slugCandidate(base, n);
      const inserted = await this.repository.insertSite({
        id: siteId,
        organizationId: actor.organizationId,
        businessId: business.id,
        slug: candidate,
        name: business.name,
        defaultLocale: first?.spec.defaultLocale ?? 'fr',
        createdBy: actor.userId,
      });
      if (inserted) slug = candidate;
    }
    if (!slug) throw new ValidationError('No free address for this site: rename the business and try again.');
    await this.events.record(SiteCreated, {
      orgId: actor.organizationId,
      payload: { siteId, businessId: business.id, slug },
    });
    if (first) {
      const site = await this.lock(actor, siteId);
      await this.saveVersion(actor, site, first, { type: 'user', id: actor.userId }, null, 'First version');
    }
    return { siteId, created: true };
  }

  /** A new version from a whole spec, if the site is still at `baseVersionId`. */
  @Transactional()
  async createVersion(
    actor: SiteActor,
    siteId: string,
    input: {
      spec: Record<string, unknown>;
      baseVersionId: string | null;
      changeSummary?: string | undefined;
    },
    author?: VersionAuthor,
  ): Promise<StoredVersion> {
    const site = await this.editable(actor, siteId, input.baseVersionId);
    const checked = checkSpec(input.spec, this.hosting);
    const current = site.currentVersionId
      ? await this.repository.version(site.id, site.currentVersionId)
      : undefined;
    const summary =
      input.changeSummary ??
      (current ? diffSpecs(migrateSpec(current.spec), checked.spec).summary : 'First version');
    return this.saveVersion(
      actor,
      site,
      checked,
      author ?? { type: 'user', id: actor.userId },
      current?.id ?? null,
      summary,
    );
  }

  /** A new version made by SiteSpec operations (atomic: all or none), if the site is still at `baseVersionId`. */
  @Transactional()
  async applyOperations(
    actor: SiteActor,
    siteId: string,
    input: {
      operations: readonly Record<string, unknown>[];
      baseVersionId: string;
      changeSummary?: string | undefined;
    },
    author?: VersionAuthor,
  ): Promise<StoredVersion> {
    const site = await this.editable(actor, siteId, input.baseVersionId);
    const current = await this.currentVersion(site);
    const parsed = OperationSchema.safeParse(
      input.operations.length === 1 ? input.operations[0] : { op: 'batch', ops: input.operations },
    );
    if (!parsed.success) throw ValidationError.fromZod(parsed.error, 'The operations are invalid.');
    const before = migrateSpec(current.spec);
    let after: SiteSpec;
    try {
      after = apply(before, parsed.data).spec;
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      throw new ValidationError(
        error.message,
        error.details.length > 0
          ? error.details.map((detail) => ({
              path: [...detail.path],
              message: detail.message,
              code: error.code,
            }))
          : [{ path: ['operations'], message: error.message, code: error.code }],
        { details: { reason: 'SITE_OPERATION_REFUSED' } },
      );
    }
    const checked = checkSpec(after, this.hosting);
    const summary = input.changeSummary ?? diffSpecs(before, checked.spec).summary;
    return this.saveVersion(
      actor,
      site,
      checked,
      author ?? { type: 'user', id: actor.userId },
      current.id,
      summary,
    );
  }

  /** The content of an earlier version as a new version (history is never rewritten). */
  @Transactional()
  async rollback(actor: SiteActor, siteId: string, input: { versionId: string; baseVersionId: string }) {
    const site = await this.editable(actor, siteId, input.baseVersionId);
    const target = await this.repository.version(site.id, input.versionId);
    if (!target) throw new NotFoundError('SiteVersion', input.versionId);
    const checked = checkSpec(target.spec, this.hosting);
    return this.saveVersion(
      actor,
      site,
      checked,
      { type: 'rollback', id: actor.userId },
      site.currentVersionId,
      `Rollback to version ${target.versionNumber}`,
    );
  }

  /** Publishes a version as the site's preview (replacing the active one), valid for `expiresInDays`. */
  @Transactional()
  async publishPreview(
    actor: SiteActor,
    siteId: string,
    input: { versionId: string; expiresInDays: number },
  ): Promise<StoredPublication> {
    const site = await this.lock(actor, siteId);
    if (site.status === 'archived') throw new SiteArchivedError(site.id, 'preview');
    const version = await this.repository.version(site.id, input.versionId);
    if (!version) throw new NotFoundError('SiteVersion', input.versionId);
    // Never publish what the current validators refuse (a version made before a stricter rule).
    checkSpec(version.spec, this.hosting);
    const now = this.clock.now();
    const active = await this.repository.activePublications(site.id);
    const previous = active.find((publication) => publication.environment === 'preview');
    if (previous) await this.repository.endPublication(previous.id, 'unpublished', now);
    const publication = await this.repository.insertPublication({
      siteId: site.id,
      versionId: version.id,
      environment: 'preview',
      hostname: previewHostname(site.slug, this.hosting.baseDomain),
      publishedBy: actor.userId,
      publishedAt: now,
      expiresAt: previewExpiry(now, input.expiresInDays),
    });
    await this.setStatus(site, [...active.filter((p) => p.environment !== 'preview'), publication]);
    await this.events.record(SitePublished, {
      orgId: actor.organizationId,
      payload: {
        ...this.publicationPayload(site, publication),
        expiresAt: publication.expiresAt?.toISOString() ?? null,
      },
    });
    await this.refresh(actor.organizationId, site, publication, `publish:${publication.id}`);
    return publication;
  }

  /** Moves the active preview's expiry later (from its current expiry, at most 90 days ahead). */
  @Transactional()
  async extendPreview(actor: SiteActor, siteId: string, days: number): Promise<StoredPublication> {
    const site = await this.lock(actor, siteId);
    if (site.status === 'archived') throw new SiteArchivedError(site.id, 'preview');
    const preview = (await this.repository.activePublications(site.id)).find(
      (p) => p.environment === 'preview',
    );
    if (!preview) throw new NoActivePublicationError('preview');
    const expiresAt = extendedExpiry(this.clock.now(), preview.expiresAt, days);
    await this.repository.setPublicationExpiry(preview.id, expiresAt);
    await this.refresh(
      actor.organizationId,
      site,
      preview,
      `extend:${preview.id}:${expiresAt.toISOString()}`,
    );
    return { ...preview, expiresAt };
  }

  /** Takes the site's publication in an environment offline. */
  @Transactional()
  async unpublish(actor: SiteActor, siteId: string, environment: SiteEnvironment): Promise<void> {
    const site = await this.lock(actor, siteId);
    const active = await this.repository.activePublications(site.id);
    const publication = active.find((p) => p.environment === environment);
    if (!publication) throw new NoActivePublicationError(environment);
    await this.end(actor.organizationId, site, publication, 'unpublished', active);
  }

  /** Archives the site: its publications go offline and it no longer changes. */
  @Transactional()
  async archive(actor: SiteActor, siteId: string): Promise<void> {
    const site = await this.lock(actor, siteId);
    if (site.status === 'archived') return;
    const active = await this.repository.activePublications(site.id);
    for (const publication of active)
      await this.end(actor.organizationId, site, publication, 'unpublished', []);
    await this.repository.setSiteStatus(site.id, 'archived');
    await this.events.record(SiteArchived, {
      orgId: actor.organizationId,
      payload: { siteId: site.id, businessId: site.businessId },
    });
  }

  /** Ends the previews whose expiry has passed (the hourly job); returns how many. */
  @Transactional()
  async expireDuePreviews(limit = 500): Promise<number> {
    const due = await this.repository.duePreviews(this.clock.now(), limit);
    for (const publication of due) {
      const actor = { organizationId: publication.organizationId, userId: null };
      const site = await this.repository.lockSite(publication.organizationId, publication.siteId);
      if (!site) continue;
      const active = await this.repository.activePublications(site.id);
      // Re-checked under the lock: an extension or an unpublish may have come first.
      const still = active.find((p) => p.id === publication.id);
      if (!still?.expiresAt || still.expiresAt > this.clock.now()) continue;
      await this.end(actor.organizationId, site, still, 'expired', active);
    }
    return due.length;
  }

  private async end(
    organizationId: string,
    site: StoredSite,
    publication: StoredPublication,
    status: 'expired' | 'unpublished',
    active: readonly StoredPublication[],
  ): Promise<void> {
    await this.repository.endPublication(publication.id, status, this.clock.now());
    await this.setStatus(
      site,
      active.filter((p) => p.id !== publication.id),
    );
    await this.events.record(status === 'expired' ? SiteExpired : SiteUnpublished, {
      orgId: organizationId,
      payload: this.publicationPayload(site, publication),
    });
    await this.refresh(organizationId, site, publication, `${status}:${publication.id}`);
  }

  private async setStatus(site: StoredSite, active: readonly StoredPublication[]): Promise<void> {
    const status = siteStatus(
      site.status,
      active.map((publication) => publication.environment),
    );
    if (status !== site.status) await this.repository.setSiteStatus(site.id, status);
  }

  private publicationPayload(site: StoredSite, publication: StoredPublication) {
    return {
      siteId: site.id,
      businessId: site.businessId,
      publicationId: publication.id,
      versionId: publication.versionId,
      environment: publication.environment,
      hostname: publication.hostname,
    };
  }

  /** Asks the renderer to refresh the site's pages once the change is committed. */
  private async refresh(
    organizationId: string,
    site: StoredSite,
    publication: StoredPublication,
    key: string,
  ): Promise<void> {
    await afterCommit(this.db, async () => {
      await this.revalidation.revalidate({
        organizationId,
        siteId: site.id,
        tags: [`site:${site.id}`, `host:${publication.hostname}`],
        idempotencyKey: `revalidate:${key}`,
      });
    });
  }

  private async lock(actor: SiteActor, siteId: string): Promise<StoredSite> {
    const site = await this.repository.lockSite(actor.organizationId, siteId);
    if (!site) throw new NotFoundError('Site', siteId);
    return site;
  }

  /** The site, locked, not archived and still at the version the edit started from. */
  private async editable(
    actor: SiteActor,
    siteId: string,
    baseVersionId: string | null,
  ): Promise<StoredSite> {
    const site = await this.lock(actor, siteId);
    if (site.status === 'archived') throw new SiteArchivedError(site.id, 'edit');
    if (site.currentVersionId !== baseVersionId) throw new SiteVersionConflictError(site.currentVersionId);
    return site;
  }

  private async currentVersion(site: StoredSite): Promise<StoredVersion> {
    const current = site.currentVersionId
      ? await this.repository.version(site.id, site.currentVersionId)
      : undefined;
    if (!current) throw new NotFoundError('SiteVersion', site.currentVersionId ?? 'current');
    return current;
  }

  private async saveVersion(
    actor: SiteActor,
    site: StoredSite,
    checked: { spec: SiteSpec; warnings: SiteIssue[] },
    author: VersionAuthor,
    parentVersionId: string | null,
    changeSummary: string,
  ): Promise<StoredVersion> {
    const version = await this.repository.insertVersion({
      siteId: site.id,
      spec: checked.spec as unknown as Record<string, unknown>,
      schemaVersion: checked.spec.schemaVersion,
      authorType: author.type,
      authorId: author.id,
      parentVersionId,
      changeSummary,
      issues: checked.warnings,
    });
    await this.repository.setCurrentVersion(site.id, version.id, checked.spec.defaultLocale);
    await this.events.record(SiteVersionCreated, {
      orgId: actor.organizationId,
      payload: {
        siteId: site.id,
        businessId: site.businessId,
        versionId: version.id,
        versionNumber: version.versionNumber,
        authorType: version.authorType,
        parentVersionId,
      },
    });
    return version;
  }
}
