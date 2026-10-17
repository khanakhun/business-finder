import {
  type Clock,
  type DomainCheck,
  type MailboxReadiness,
  NotFoundError,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { AuditLogger } from '../../../workspace/index.ts';
import { checkDomain, type DnsLookups, readinessBlockers } from '../../domain/deliverability/domain-check.ts';
import { MAILBOX_REPOSITORY, type MailboxRecord, type MailboxRepository } from '../mailbox/ports.ts';
import {
  DELIVERABILITY_REPOSITORY,
  type DeliverabilityRepository,
  type MailboxReadinessGate,
} from './ports.ts';

// Sending-domain authentication and the readiness gate (BF-056). A domain's checks are cached six hours and re-run
// daily (the hourly mailbox sweep) or on demand. A mailbox whose domain fails SPF or DKIM, or has no DMARC, does not
// send — not automatically, and a one-click send is refused with the fix — unless an owner overrides it for that
// mailbox with a reason (audited). A domain never checked, or whose DNS did not answer, does not block.

const CACHE_MS = 6 * 3_600_000;
const DAILY_MS = 24 * 3_600_000;

export const DNS_LOOKUPS = Symbol('DnsLookups');

export const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

@Injectable()
export class DeliverabilityService implements MailboxReadinessGate {
  constructor(
    @Inject(DELIVERABILITY_REPOSITORY) private readonly repository: DeliverabilityRepository,
    @Inject(MAILBOX_REPOSITORY) private readonly mailboxes: MailboxRepository,
    @Inject(DNS_LOOKUPS) private readonly dns: DnsLookups,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditLogger,
  ) {}

  /** The mailbox's domain check, from the cache when fresh (or always re-run when `force`). */
  async check(mailbox: MailboxRecord, force = false): Promise<DomainCheck> {
    const domain = domainOf(mailbox.email);
    const cached = await this.repository.domainCheck(mailbox.organizationId, domain);
    const now = this.clock.now();
    if (!force && cached && now.getTime() - Date.parse(cached.checkedAt) < CACHE_MS) return cached;
    const fresh = await checkDomain(domain, mailbox.provider, this.dns, now);
    await this.repository.saveDomainCheck(mailbox.organizationId, fresh);
    return fresh;
  }

  /** The daily re-check (the hourly sweep calls it per mailbox; checks older than a day are re-run). */
  async ensureFresh(mailbox: MailboxRecord): Promise<void> {
    const cached = await this.repository.domainCheck(mailbox.organizationId, domainOf(mailbox.email));
    if (!cached || this.clock.now().getTime() - Date.parse(cached.checkedAt) >= DAILY_MS)
      await this.check(mailbox, true);
  }

  async isReady(organizationId: string, mailboxId: string, email: string): Promise<boolean> {
    const check = await this.repository.domainCheck(organizationId, domainOf(email));
    if (!check || readinessBlockers(check.checks).length === 0) return true;
    return (await this.repository.override(organizationId, mailboxId)) !== undefined;
  }

  async readiness(organizationId: string): Promise<MailboxReadiness[]> {
    const mailboxes = (await this.mailboxes.list(organizationId)).filter(
      (mailbox) => !mailbox.disconnectedAt,
    );
    const overrides = new Map(
      (await this.repository.overrides(organizationId)).map((row) => [row.mailboxId, row]),
    );
    return Promise.all(
      mailboxes.map(async (mailbox) => {
        const check = (await this.repository.domainCheck(organizationId, domainOf(mailbox.email))) ?? null;
        const blockers = check ? readinessBlockers(check.checks) : [];
        const override = overrides.get(mailbox.id);
        return {
          mailboxId: mailbox.id,
          email: mailbox.email,
          domain: domainOf(mailbox.email),
          ready: blockers.length === 0 || override !== undefined,
          blockers,
          override: override
            ? { reason: override.reason, by: override.createdBy, at: override.createdAt.toISOString() }
            : null,
          check,
        };
      }),
    );
  }

  /** The preview sites' domain on the blocklist (every email links to it): null when off or unanswered. */
  async sitesDomainListed(sitesDomain: string): Promise<{ enabled: boolean; listed: boolean | null }> {
    if (!this.dns.listed) return { enabled: false, listed: null };
    return { enabled: true, listed: await this.dns.listed(sitesDomain) };
  }

  async recheck(organizationId: string, mailboxId: string): Promise<DomainCheck> {
    return this.check(await this.load(organizationId, mailboxId), true);
  }

  async setOverride(organizationId: string, mailboxId: string, reason: string, userId: string | null) {
    const mailbox = await this.load(organizationId, mailboxId);
    if (reason.trim().length < 10)
      throw new ValidationError('Say why this mailbox may send despite its checks.', [
        { path: ['reason'], message: 'At least 10 characters' },
      ]);
    await this.repository.setOverride(organizationId, mailbox.id, reason.trim(), userId);
    await this.audit.record({
      action: 'deliverability.override_set',
      organizationId,
      entityType: 'mailbox',
      entityId: mailbox.id,
      metadata: { reason: reason.trim(), domain: domainOf(mailbox.email) },
    });
  }

  async clearOverride(organizationId: string, mailboxId: string) {
    const mailbox = await this.load(organizationId, mailboxId);
    if (await this.repository.clearOverride(organizationId, mailbox.id))
      await this.audit.record({
        action: 'deliverability.override_cleared',
        organizationId,
        entityType: 'mailbox',
        entityId: mailbox.id,
      });
  }

  private async load(organizationId: string, mailboxId: string) {
    const mailbox = await this.mailboxes.find(organizationId, mailboxId);
    if (!mailbox) throw new NotFoundError('Mailbox', mailboxId);
    return mailbox;
  }
}
