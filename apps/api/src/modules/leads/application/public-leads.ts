import { createHash } from 'node:crypto';
import {
  type Clock,
  newId,
  type PublicLead,
  type PublicLeadResponse,
  SiteLeadCaptured,
  SiteOptOutRequested,
  verifyLeadFormToken,
  verifySiteViewToken,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { withoutClientDetails } from '../../platform/context/request-context.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import { contentSignals, isSpam, type SpamSignal, timingSignals, verdict } from '../domain/spam-policy.ts';
import {
  LEAD_GUARD,
  LEAD_TOKEN_SECRET,
  LEADS_REPOSITORY,
  type LeadGuard,
  type LeadSite,
  type LeadsRepository,
  PROOF_OF_WORK,
  type ProofOfWork,
} from './ports.ts';

// Anonymous leads from preview sites (BF-048): the site token names the site, the form token says when the form was
// rendered; then idempotency (the submission id), the anti-spam chain (honeypot, timing, proof of work, rate limits
// on a daily network hash, content), storage with consent and attribution, and an event for the automation. An
// opt-out is honoured even when the preview ended in the last 7 days or the signals look odd. Nothing here says
// whether the site or business exists: every refusal is the same "received".

export class LeadCaptureDisabledError extends Error {}

/** Opt-outs still count this long after the preview ended. */
const OPT_OUT_GRACE_MS = 7 * 24 * 60 * 60_000;

const RECEIVED = (kind: PublicLead['kind']): PublicLeadResponse => ({
  status: 'received',
  messageKey: kind === 'opt_out' ? 'optout.received' : 'lead.received',
});

/** A phone number as E.164 when it reads as one (digits with an optional +), else as typed. */
function phoneOf(value: string | undefined): string | null {
  if (!value) return null;
  const compact = value.replace(/[\s().-]/g, '');
  return /^\+?\d{6,15}$/.test(compact) ? (compact.startsWith('+') ? compact : compact) : value.slice(0, 40);
}

@Injectable()
export class PublicLeads {
  constructor(
    @Inject(LEADS_REPOSITORY) private readonly repository: LeadsRepository,
    @Inject(LEAD_GUARD) private readonly guard: LeadGuard,
    @Inject(PROOF_OF_WORK) private readonly pow: ProofOfWork,
    @Inject(LEAD_TOKEN_SECRET) private readonly secret: string | null,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly events: EventRecorder,
  ) {}

  /** A proof-of-work challenge for a site's form (harder while the site receives spam). */
  async challenge(siteToken: string): Promise<Record<string, unknown>> {
    if (!this.secret) throw new LeadCaptureDisabledError();
    const siteId = await verifySiteViewToken(siteToken, this.secret);
    // An unknown token still gets a (useless) challenge: the answer does not tell whether the site exists.
    const hard = siteId ? (await this.guard.recentSpam(siteId)) > 5 : false;
    return this.pow.challenge({ siteId: siteId ?? 'unknown', hard });
  }

  async submit(lead: PublicLead, client: { ip: string | undefined }): Promise<PublicLeadResponse> {
    if (!this.secret) throw new LeadCaptureDisabledError();
    const siteId = await verifySiteViewToken(lead.siteToken, this.secret);
    if (!siteId) return RECEIVED(lead.kind);
    const site = await this.repository.siteForLead(siteId);
    if (!site || !this.accepts(site, lead.kind)) return RECEIVED(lead.kind);
    if (await this.repository.bySubmission(siteId, lead.submissionId)) return RECEIVED(lead.kind);

    const signals: SpamSignal[] = [];
    if (lead.hp?.trim()) signals.push('honeypot');
    const form = await verifyLeadFormToken(lead.formToken, this.secret);
    signals.push(
      ...timingSignals(
        form && form.siteId === siteId ? form.renderedAtMs : undefined,
        this.clock.now().getTime(),
      ),
    );
    if (!lead.altcha) signals.push('altcha_missing');
    else {
      const proof = await this.pow.verify(lead.altcha);
      if (!proof.ok || (proof.signature && (await this.guard.challengeUsed(proof.signature))))
        signals.push('altcha_failed');
    }
    const network = await this.guard.networkHash(client.ip);
    if (network && (await this.guard.overIpLimit(siteId, network))) signals.push('rate_ip');
    if (await this.guard.overSiteLimit(siteId)) signals.push('rate_site');
    signals.push(...contentSignals(lead));
    const content = createHash('sha256')
      .update(`${lead.kind}|${lead.email ?? ''}|${lead.phone ?? ''}|${lead.message ?? ''}`)
      .digest('hex');
    if (lead.kind !== 'opt_out' && (await this.guard.repeated(siteId, content))) signals.push('repeated');
    const spam = verdict(signals);
    const spammy = isSpam(lead.kind, spam);
    if (spammy) await this.guard.noteSpam(siteId);

    await withoutClientDetails(() => this.store(site, lead, spam, spammy));
    // No PII in logs: the site, the kind and the verdict only.
    this.logger.info(
      { siteId, kind: lead.kind, spam: spam.score, signals: spam.signals },
      'site lead received',
    );
    return RECEIVED(lead.kind);
  }

  /** Claims and contact requests while the preview is published; opt-outs also within the grace after it ended. */
  private accepts(site: LeadSite, kind: PublicLead['kind']): boolean {
    if (site.active) return true;
    return (
      kind === 'opt_out' &&
      site.endedAt !== null &&
      this.clock.now().getTime() - site.endedAt.getTime() <= OPT_OUT_GRACE_MS
    );
  }

  @Transactional()
  private async store(site: LeadSite, lead: PublicLead, spam: ReturnType<typeof verdict>, spammy: boolean) {
    const now = this.clock.now();
    const { lead: stored, created } = await this.repository.insert({
      id: newId(),
      organizationId: site.organizationId,
      siteId: site.siteId,
      businessId: site.businessId,
      publicationId: site.publicationId,
      kind: lead.kind,
      source: lead.source,
      name: lead.name ?? null,
      email: lead.email?.toLowerCase() ?? null,
      phone: phoneOf(lead.phone),
      whatsapp: phoneOf(lead.whatsapp),
      message: lead.message ?? null,
      preferredChannel: lead.preferredChannel ?? null,
      preferredTime: lead.preferredTime ?? null,
      locale: lead.locale,
      consent: {
        checked: lead.consent,
        textVersion: lead.consentVersion || 'unversioned',
        at: now.toISOString(),
      },
      attribution: {
        campaignRef: lead.c ?? null,
        outreachRef: lead.r ?? null,
        siteVersionId: site.versionId,
        generationJobId: site.generationJobId,
        engine: site.engine,
      },
      spam,
      status: spammy ? 'spam' : 'new',
      submissionId: lead.submissionId,
    });
    if (!created) return;
    const payload = { leadId: stored.id, siteId: site.siteId, businessId: site.businessId };
    if (lead.kind === 'opt_out') {
      await this.events.record(SiteOptOutRequested, {
        orgId: site.organizationId,
        actor: { type: 'system', id: null },
        payload: { ...payload, removePreview: lead.removePreview ?? false, outreachRef: lead.r ?? null },
      });
    } else if (!spammy) {
      await this.events.record(SiteLeadCaptured, {
        orgId: site.organizationId,
        actor: { type: 'system', id: null },
        payload: {
          ...payload,
          kind: lead.kind,
          source: lead.source,
          channel:
            lead.preferredChannel ??
            (lead.phone ? 'phone' : lead.whatsapp ? 'whatsapp' : lead.email ? 'email' : null),
          contactName: lead.name?.split(/\s+/)[0]?.slice(0, 60) ?? null,
          attribution: stored.attribution,
        },
      });
    }
  }
}
