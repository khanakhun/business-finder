import { type DomainEvent, SITE_RENDER_EVENTS } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { type DeliveryMeta, OnDomainEvent } from '../../platform/events/on-domain-event.decorator.ts';
import { SITE_REVALIDATION, type SiteRevalidation } from './ports.ts';

type RenderEvent = DomainEvent<(typeof SITE_RENDER_EVENTS)[number]>;

/**
 * Refreshes the renderer after every publication change (BF-035): driven by the outbox, so a change that committed
 * is never left unrevalidated (the event is delivered until it succeeds; the job then retries the renderer).
 */
@Injectable()
export class SiteRenderSubscriber {
  constructor(@Inject(SITE_REVALIDATION) private readonly revalidation: SiteRevalidation) {}

  @OnDomainEvent(SITE_RENDER_EVENTS, { id: 'sites.revalidate-renderer' })
  async revalidate(event: RenderEvent, _meta: DeliveryMeta): Promise<void> {
    if (!event.orgId) return;
    await this.revalidation.revalidate({
      organizationId: event.orgId,
      siteId: event.payload.siteId,
      tags: [`site:${event.payload.siteId}`, `host:${event.payload.hostname}`],
      idempotencyKey: `revalidate:${event.id}`,
    });
  }
}
