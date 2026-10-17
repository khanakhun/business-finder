import type { Mailbox, MailboxEvent, MailboxUsageDay } from '@bf/contracts';
import { effectiveCap, rampPlan } from '../../domain/mailbox/capacity-policy.ts';
import { canSend } from '../../domain/mailbox/mailbox-state-machine.ts';
import { nextWindowOpening } from '../../domain/mailbox/window-policy.ts';
import { addDays, localDate } from '../../domain/mailbox/zoned-time.ts';
import type { MailboxEventRow, MailboxRecord, MailboxUsageRow } from './ports.ts';

// API views of a mailbox (BF-050): never the secret ref or provider state.

export interface TodayUsage {
  readonly sent: number;
  readonly failed: number;
  readonly bounced: number;
  readonly reserved: number;
}

export const mailboxDay = (mailbox: MailboxRecord, at: Date) => localDate(at, mailbox.window.mailboxTimezone);

export function toMailbox(mailbox: MailboxRecord, today: TodayUsage, now: Date): Mailbox {
  return {
    id: mailbox.id,
    ownerUserId: mailbox.ownerUserId,
    provider: mailbox.provider,
    email: mailbox.email,
    displayName: mailbox.displayName,
    status: mailbox.status,
    statusReason: mailbox.statusReason,
    dailyCap: mailbox.dailyCap,
    ramp: mailbox.ramp,
    window: mailbox.window,
    minIntervalSec: mailbox.minIntervalSec,
    locales: mailbox.locales,
    signatureMd: mailbox.signatureMd,
    replyTo: mailbox.replyTo,
    health: mailbox.health,
    lastError: mailbox.lastError,
    today: { day: mailboxDay(mailbox, now), effectiveCap: effectiveCap(mailbox, now), ...today },
    nextWindowAt: canSend(mailbox.status)
      ? (nextWindowOpening(mailbox.window, mailbox.window.mailboxTimezone, now)?.toISOString() ?? null)
      : null,
    createdAt: mailbox.createdAt.toISOString(),
    updatedAt: mailbox.updatedAt.toISOString(),
  };
}

export const toMailboxEvent = (row: MailboxEventRow): MailboxEvent => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});

/** The last 30 days as recorded, then the next 14 days as planned by the ramp. */
export function usageSeries(mailbox: MailboxRecord, rows: MailboxUsageRow[], now: Date): MailboxUsageDay[] {
  const today = mailboxDay(mailbox, now);
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const past: MailboxUsageDay[] = [];
  for (let i = -29; i <= 0; i++) {
    const day = addDays(today, i);
    const row = byDay.get(day);
    const at = new Date(now.getTime() + i * 86_400_000);
    past.push({
      day,
      planned: rampPlan(mailbox, at, 1)[0]?.cap ?? 0,
      sent: row?.sent ?? 0,
      failed: row?.failed ?? 0,
      bounced: row?.bounced ?? 0,
      complaints: row?.complaints ?? 0,
      replies: row?.replies ?? 0,
    });
  }
  const future = rampPlan(mailbox, new Date(now.getTime() + 86_400_000), 14).map((point, index) => ({
    day: addDays(today, index + 1),
    planned: point.cap,
    sent: 0,
    failed: 0,
    bounced: 0,
    complaints: 0,
    replies: 0,
  }));
  return [...past, ...future];
}
