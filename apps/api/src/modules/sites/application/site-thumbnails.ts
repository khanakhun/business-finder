import { type Clock, type DomainEvent, NotFoundError, SitePublished } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { type DeliveryMeta, OnDomainEvent } from '../../platform/events/on-domain-event.decorator.ts';
import type { ObjectStorage } from '../../platform/storage/object-storage.ts';
import { publicationUrl } from './mappers.ts';
import {
  SITE_ARTIFACTS,
  SITE_SCREENSHOT_QUEUE,
  SITE_SCREENSHOTTER,
  SITE_THUMBNAILS_REPOSITORY,
  SITES_REPOSITORY,
  type SiteInsights,
  type SiteScreenshotQueue,
  type SiteScreenshotter,
  type SitesRepository,
  type SiteThumbnailsRepository,
  type StoredThumbnails,
} from './ports.ts';
import { SiteViewsFlusher } from './site-views.ts';

/** Where a site's pictures go in the artifacts bucket (keys are prefixed with the workspace, like every object). */
const artifactsPrefix = (organizationId: string, siteId: string) => `orgs/${organizationId}/sites/${siteId}/`;

/**
 * Pictures of published sites for the dashboard's cards (BF-035): after each publication, a job asks services/intel
 * to photograph the home page (desktop and mobile); the keys are kept on the site, the files stay in the private
 * artifacts bucket and are served to members through the API.
 */
@Injectable()
export class SiteThumbnailCommands {
  constructor(
    @Inject(SITES_REPOSITORY) private readonly sites: SitesRepository,
    @Inject(SITE_THUMBNAILS_REPOSITORY) private readonly thumbnails: SiteThumbnailsRepository,
    @Inject(SITE_SCREENSHOTTER) private readonly screenshotter: SiteScreenshotter,
    @Inject(SITE_SCREENSHOT_QUEUE) private readonly queue: SiteScreenshotQueue,
    @Inject(SITE_ARTIFACTS) private readonly artifacts: ObjectStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @OnDomainEvent([SitePublished], { id: 'sites.screenshot-publication' })
  async onPublished(event: DomainEvent<typeof SitePublished>, _meta: DeliveryMeta): Promise<void> {
    if (!event.orgId) return;
    await this.queue.capture({
      organizationId: event.orgId,
      siteId: event.payload.siteId,
      publicationId: event.payload.publicationId,
      idempotencyKey: `screenshot:${event.payload.publicationId}`,
    });
  }

  /**
   * The job: photographs the publication while it is active; idempotent (a retake overwrites the same keys). The
   * pictures are kept only if the publication is still active when they are stored (one statement): a late job of an
   * earlier publication never replaces a later one's.
   */
  async capture(siteId: string, publicationId: string, signal: AbortSignal): Promise<'taken' | 'skipped'> {
    const publication = await this.thumbnails.publication(siteId, publicationId);
    if (publication?.status !== 'active') return 'skipped';
    const keys = await this.screenshotter.capture(
      publicationUrl(publication.hostname),
      `${artifactsPrefix(publication.organizationId, siteId)}${publicationId}`,
      signal,
    );
    const stored = await this.thumbnails.setIfActive(siteId, {
      publicationId,
      takenAt: this.clock.now().toISOString(),
      desktopKey: keys.desktopKey,
      mobileKey: keys.mobileKey,
    });
    return stored ? 'taken' : 'skipped';
  }

  /** A picture of a site of the workspace (404 when the site, or that picture, does not exist). */
  async file(organizationId: string, siteId: string, kind: 'desktop' | 'mobile') {
    const site = await this.sites.site(organizationId, siteId);
    if (!site) throw new NotFoundError('Site', siteId);
    const thumbnails = await this.thumbnails.get(site.id);
    const key = kind === 'desktop' ? thumbnails?.desktopKey : thumbnails?.mobileKey;
    // Only keys under the site's own prefix (written by the job above) are ever read.
    const object = key?.startsWith(artifactsPrefix(organizationId, site.id))
      ? await this.artifacts.get(key)
      : undefined;
    if (!object) throw new NotFoundError('SiteThumbnail', `${siteId}/${kind}`);
    return object;
  }
}

/** The detail's pictures and views. */
@Injectable()
export class SiteInsightsReader implements SiteInsights {
  constructor(
    @Inject(SITE_THUMBNAILS_REPOSITORY) private readonly repository: SiteThumbnailsRepository,
    private readonly viewStats: SiteViewsFlusher,
  ) {}

  thumbnails(siteId: string): Promise<StoredThumbnails | null> {
    return this.repository.get(siteId);
  }

  views(siteId: string) {
    return this.viewStats.stats(siteId);
  }
}
