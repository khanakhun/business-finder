import { type DomainEvent, UnsubscribeConfirmed } from '@bf/contracts';
import { Injectable } from '@nestjs/common';
import { CrmPipeline } from '../../crm/index.ts';
import { OnDomainEvent } from '../../platform/events/on-domain-event.decorator.ts';
import { SiteCommands, SiteQueries } from '../../sites/index.ts';
import { AuditLogger } from '../../workspace/index.ts';

// What an unsubscribe choice sets in motion beyond the suppression (BF-055; the same effects as a preview opt-out,
// BF-048): "stop all contact with my business" → do-not-contact; "remove the preview" → every published preview of
// the business is taken down. Safe to repeat.

const REASON = 'Unsubscribed from an outreach message';

@Injectable()
export class UnsubscribeEffects {
  constructor(
    private readonly crm: CrmPipeline,
    private readonly sites: SiteCommands,
    private readonly siteQueries: SiteQueries,
    private readonly audit: AuditLogger,
  ) {}

  @OnDomainEvent(UnsubscribeConfirmed, { id: 'leads.on-unsubscribe' })
  async unsubscribed(event: DomainEvent<typeof UnsubscribeConfirmed>): Promise<void> {
    const orgId = event.orgId;
    const { businessId, choices } = event.payload;
    if (!orgId || !businessId) return;
    if (choices.includes('business')) await this.crm.doNotContact(orgId, businessId, REASON);
    if (!choices.includes('preview')) return;
    const page = await this.siteQueries.list(orgId, { businessId, limit: 50 } as never);
    for (const site of page.items) {
      try {
        await this.sites.unpublish({ organizationId: orgId, userId: null }, site.id, 'preview');
      } catch (error) {
        if ((error as { details?: { reason?: string } }).details?.reason !== 'NO_ACTIVE_PUBLICATION')
          throw error;
      }
    }
    await this.audit.record({
      action: 'site.preview_removed_on_unsubscribe',
      entityType: 'business',
      entityId: businessId,
      metadata: { sites: page.items.length },
    });
  }
}
