import { type DomainEvent, SiteOptOutRequested } from '@bf/contracts';
import { Injectable } from '@nestjs/common';
import { OnDomainEvent } from '../../platform/events/on-domain-event.decorator.ts';
import { ComplianceService } from './compliance.service.ts';

// A "don't contact me" from a preview (BF-048) suppresses the business for the workspace (BF-049): no email, call or
// message passes the gate afterwards, on any mailbox or sequence. Idempotent (an existing suppression is kept).

@Injectable()
export class ComplianceSubscribers {
  constructor(private readonly compliance: ComplianceService) {}

  @OnDomainEvent(SiteOptOutRequested, { id: 'compliance.on-site-opt-out' })
  async optedOut(event: DomainEvent<typeof SiteOptOutRequested>): Promise<void> {
    if (!event.orgId) return;
    await this.compliance.suppress({
      organizationId: event.orgId,
      scope: 'org_business',
      value: event.payload.businessId,
      reason: 'opt_out',
      source: 'site_form',
      actor: { type: 'system', id: null },
      note: `Preview opt-out (lead ${event.payload.leadId})`,
    });
  }
}
