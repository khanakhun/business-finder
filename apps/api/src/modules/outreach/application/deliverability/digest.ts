import type { Clock } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { MemberDirectory } from '../../../identity/index.ts';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { NotificationService } from '../../../realtime/index.ts';
import { MAILBOX_REPOSITORY, type MailboxRepository, RUN_LOCK, type RunLock } from '../mailbox/ports.ts';
import { DeliverabilityHealth } from './health.ts';

// The weekly deliverability digest (BF-056): on Monday morning (UTC), owners and admins of each workspace with
// mailboxes get one summary — emails sent over the week, the bounce rate, the mailboxes that need attention — in the
// app and by email (each person can turn the email off in their notification preferences). Once per workspace and
// week, whatever the number of workers.

const WEEK_SECONDS = 7 * 86_400;
const BATCH = 200;

function isoWeek(at: Date): string {
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

@Injectable()
export class DeliverabilityDigest {
  constructor(
    @Inject(MAILBOX_REPOSITORY) private readonly mailboxes: MailboxRepository,
    @Inject(RUN_LOCK) private readonly lock: RunLock,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly health: DeliverabilityHealth,
    private readonly members: MemberDirectory,
    private readonly notifications: NotificationService,
  ) {}

  /** Due on Mondays from 08:00 UTC (the tick calls it every minute; the lock makes it once a week). */
  async runIfDue(): Promise<number> {
    const now = this.clock.now();
    if (now.getUTCDay() !== 1 || now.getUTCHours() < 8) return 0;
    const week = isoWeek(now);
    const organizations = new Set<string>();
    let afterId: string | undefined;
    for (;;) {
      const batch = await this.mailboxes.listForHealth(BATCH, afterId);
      for (const mailbox of batch) organizations.add(mailbox.organizationId);
      if (batch.length < BATCH) break;
      afterId = batch.at(-1)?.id;
    }
    let sent = 0;
    for (const organizationId of organizations) {
      if (!(await this.lock.acquire(`deliverability-digest:${organizationId}:${week}`, WEEK_SECONDS)))
        continue;
      const stats = await this.health.stats(organizationId);
      const emails = stats.reduce((sum, mailbox) => sum + mailbox.sends7d, 0);
      const bounces = stats.reduce((sum, mailbox) => sum + mailbox.bounces.count, 0);
      const last50 = stats.reduce((sum, mailbox) => sum + mailbox.bounces.n, 0);
      const attention = stats.filter((mailbox) => mailbox.warnings.length > 0 || mailbox.status === 'paused');
      const recipients = await this.members.ownerIds(organizationId);
      if (recipients.length === 0) continue;
      await this.notifications.notify({
        organizationId,
        recipients,
        type: 'deliverability_digest',
        params: {
          sent: emails,
          bounceRate: last50 > 0 ? `${Math.round((bounces / last50) * 1000) / 10}%` : '0%',
          summary: (attention.length > 0
            ? `Needs attention: ${attention.map((mailbox) => `${mailbox.email} (${mailbox.status}${mailbox.warnings[0] ? `, ${mailbox.warnings[0]}` : ''})`).join('; ')}`
            : 'All mailboxes look healthy.'
          ).slice(0, 200),
        },
        link: '/outreach/deliverability',
      });
      sent++;
    }
    return sent;
  }
}
