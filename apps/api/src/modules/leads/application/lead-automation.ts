import { type Clock, type DomainEvent, SiteLeadCaptured, SiteOptOutRequested } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CrmPipeline } from '../../crm/index.ts';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { OnDomainEvent } from '../../platform/events/on-domain-event.decorator.ts';
import { NotificationService, RealtimePublisher } from '../../realtime/index.ts';
import { SiteCommands } from '../../sites/index.ts';
import { AuditLogger, WorkspaceDefaults } from '../../workspace/index.ts';
import { nextBusinessMorning } from '../domain/business-day.ts';
import { LEADS_REPOSITORY, type LeadsRepository } from './ports.ts';

// What a preview lead sets in motion (BF-048, subscribers of the outbox; each step safe to repeat):
// - a claim or contact request: the business becomes Engaged (never a step back), a call-back task for its owner
//   (else the site's creator) due the next business morning, a notification and the inbox's realtime update;
// - an opt-out: do-not-contact at once, the preview taken down when asked, the owner told. Formal suppression is
//   BF-055's subscriber to the same event.

const CHANNEL_WORD: Record<string, string> = { phone: 'phone', whatsapp: 'WhatsApp', email: 'email' };

@Injectable()
export class LeadAutomation {
  constructor(
    @Inject(LEADS_REPOSITORY) private readonly repository: LeadsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly crm: CrmPipeline,
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimePublisher,
    private readonly sites: SiteCommands,
    private readonly workspace: WorkspaceDefaults,
    private readonly audit: AuditLogger,
  ) {}

  @OnDomainEvent(SiteLeadCaptured, { id: 'leads.on-captured' })
  async captured(event: DomainEvent<typeof SiteLeadCaptured>): Promise<void> {
    const orgId = event.orgId;
    if (!orgId) return;
    const { leadId, siteId, businessId, channel, contactName } = event.payload;
    const site = await this.repository.siteForLead(siteId);
    await this.crm.markEngaged(orgId, businessId);
    const owner = (await this.crm.ownerOf(orgId, businessId)) ?? site?.createdBy ?? null;
    const who = contactName ?? 'the lead';
    await this.crm.followUp(orgId, businessId, {
      title: channel ? `Call back ${who} (${CHANNEL_WORD[channel] ?? channel})` : `Get back to ${who}`,
      type: channel === 'email' ? 'email' : 'call',
      dueAt: nextBusinessMorning(this.clock.now(), await this.workspace.timeZone(orgId)),
      assigneeId: owner,
    });
    await this.notifications.notify({
      organizationId: orgId,
      recipients: owner ? [owner] : 'members',
      type: 'lead_captured',
      params: {
        site: (site?.siteName ?? '').slice(0, 120),
        business: (site?.businessName ?? '').slice(0, 120),
      },
      entity: { type: 'site_lead', id: leadId },
      link: `/leads?lead=${leadId}`,
      sourceEventId: event.id,
    });
    await this.realtime.publish(orgId, { type: 'lead.created', entity: 'site_lead', entityId: leadId });
  }

  @OnDomainEvent(SiteOptOutRequested, { id: 'leads.on-opt-out' })
  async optedOut(event: DomainEvent<typeof SiteOptOutRequested>): Promise<void> {
    const orgId = event.orgId;
    if (!orgId) return;
    const { leadId, siteId, businessId, removePreview } = event.payload;
    await this.crm.doNotContact(orgId, businessId, 'Asked not to be contacted from the preview site');
    if (removePreview) {
      try {
        await this.sites.unpublish({ organizationId: orgId, userId: null }, siteId, 'preview');
      } catch (error) {
        // Already down (expired, unpublished): nothing to take down.
        if ((error as { details?: { reason?: string } }).details?.reason !== 'NO_ACTIVE_PUBLICATION')
          throw error;
      }
    }
    await this.audit.record({
      action: 'site.lead_opted_out',
      entityType: 'site',
      entityId: siteId,
      metadata: { leadId, businessId, removePreview },
    });
    const site = await this.repository.siteForLead(siteId);
    const owner = (await this.crm.ownerOf(orgId, businessId)) ?? site?.createdBy ?? null;
    await this.notifications.notify({
      organizationId: orgId,
      recipients: owner ? [owner] : 'members',
      type: 'lead_opted_out',
      params: { business: (site?.businessName ?? '').slice(0, 120) },
      entity: { type: 'site_lead', id: leadId },
      link: `/leads?lead=${leadId}`,
      sourceEventId: event.id,
    });
    await this.realtime.publish(orgId, { type: 'lead.created', entity: 'site_lead', entityId: leadId });
  }
}
