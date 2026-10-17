import {
  type LeadListQuery,
  NotFoundError,
  type SiteLead,
  type SiteLeadPage,
  type UpdateLeadRequest,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '../../platform/db/transactional.ts';
import { RealtimePublisher } from '../../realtime/index.ts';
import { AuditLogger } from '../../workspace/index.ts';
import { LEADS_REPOSITORY, type LeadsRepository, type ListedLead } from './ports.ts';

// The leads inbox (BF-048): a workspace's leads, newest first (spam only when asked for), one lead, its status and
// assignee, notes (on the business's timeline), the unread count, and a CSV export (audited).

export interface InboxActor {
  readonly organizationId: string;
  readonly userId: string;
  /** Admins see the spam signals. */
  readonly admin: boolean;
}

const toLead = (lead: ListedLead, admin: boolean): SiteLead => ({
  id: lead.id,
  siteId: lead.siteId as SiteLead['siteId'],
  businessId: lead.businessId as SiteLead['businessId'],
  businessName: lead.businessName,
  siteName: lead.siteName,
  kind: lead.kind,
  source: lead.source,
  name: lead.name,
  email: lead.email,
  phone: lead.phone,
  whatsapp: lead.whatsapp,
  message: lead.message,
  preferredChannel: lead.preferredChannel,
  preferredTime: lead.preferredTime,
  locale: lead.locale,
  consent: lead.consent,
  attribution: lead.attribution,
  spam: admin ? lead.spam : null,
  status: lead.status,
  handledBy: lead.handledBy,
  createdAt: lead.createdAt.toISOString(),
  updatedAt: lead.updatedAt.toISOString(),
});

const encodeCursor = (lead: ListedLead) =>
  Buffer.from(`${lead.createdAt.toISOString()}|${lead.id}`).toString('base64url');
function decodeCursor(cursor: string | undefined) {
  if (!cursor) return undefined;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at ?? '');
  return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : undefined;
}

/** A CSV cell: quoted, and never starting a formula in a spreadsheet. */
const cell = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

@Injectable()
export class LeadsInbox {
  constructor(
    @Inject(LEADS_REPOSITORY) private readonly repository: LeadsRepository,
    private readonly realtime: RealtimePublisher,
    private readonly audit: AuditLogger,
  ) {}

  async list(actor: InboxActor, query: LeadListQuery): Promise<SiteLeadPage> {
    const after = decodeCursor(query.cursor);
    const rows = await this.repository.list(actor.organizationId, {
      ...query,
      limit: query.limit + 1,
      ...(after ? { after } : {}),
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((lead) => toLead(lead, actor.admin)),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
    };
  }

  async get(actor: InboxActor, leadId: string): Promise<SiteLead> {
    const lead = await this.repository.get(actor.organizationId, leadId);
    if (!lead) throw new NotFoundError('SiteLead', leadId);
    return toLead(lead, actor.admin);
  }

  async counts(actor: InboxActor) {
    return { new: await this.repository.countNew(actor.organizationId) };
  }

  @Transactional()
  async update(actor: InboxActor, leadId: string, request: UpdateLeadRequest): Promise<SiteLead> {
    const lead = await this.repository.get(actor.organizationId, leadId);
    if (!lead) throw new NotFoundError('SiteLead', leadId);
    if (lead.status === 'spam' && request.status)
      throw new ValidationError('A lead marked as spam stays spam.', [
        { path: ['status'], message: 'Spam leads cannot change status', code: 'spam' },
      ]);
    await this.repository.update(actor.organizationId, leadId, {
      ...(request.status ? { status: request.status } : {}),
      ...(request.handledBy !== undefined ? { handledBy: request.handledBy } : {}),
    });
    if (request.note || request.status) {
      await this.audit.record({
        action: 'site.lead_updated',
        entityType: 'site_lead',
        entityId: leadId,
        metadata: {
          ...(request.status ? { from: lead.status, to: request.status } : {}),
          ...(request.note ? { note: request.note.slice(0, 2000) } : {}),
        },
      });
    }
    await this.realtime.publish(actor.organizationId, {
      type: 'lead.updated',
      entity: 'site_lead',
      entityId: leadId,
    });
    return this.get(actor, leadId);
  }

  /** The leads matching the filters as CSV (at most 5 000 rows), audited. */
  async exportCsv(actor: InboxActor, query: LeadListQuery): Promise<string> {
    const rows = await this.repository.list(actor.organizationId, { ...query, limit: 5_000 });
    await this.audit.record({
      action: 'site.leads_exported',
      entityType: 'organization',
      entityId: actor.organizationId,
      metadata: { rows: rows.length, filters: { ...query, cursor: undefined } },
    });
    const header = [
      'created_at',
      'kind',
      'status',
      'business',
      'site',
      'name',
      'email',
      'phone',
      'whatsapp',
      'preferred_channel',
      'preferred_time',
      'message',
      'campaign',
      'consent_version',
    ];
    const lines = rows.map((lead) =>
      [
        lead.createdAt.toISOString(),
        lead.kind,
        lead.status,
        lead.businessName,
        lead.siteName,
        lead.name,
        lead.email,
        lead.phone,
        lead.whatsapp,
        lead.preferredChannel,
        lead.preferredTime,
        lead.message,
        lead.attribution.campaignRef,
        lead.consent.textVersion,
      ]
        .map(cell)
        .join(','),
    );
    return `${header.join(',')}\n${lines.join('\n')}\n`;
  }
}
