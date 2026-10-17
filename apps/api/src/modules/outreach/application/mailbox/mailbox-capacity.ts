import type { Clock, Locale, MailboxSelection } from '@bf/contracts';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { effectiveCap } from '../../domain/mailbox/capacity-policy.ts';
import { canSend } from '../../domain/mailbox/mailbox-state-machine.ts';
import { type MailboxCandidate, rank } from '../../domain/mailbox/selector.ts';
import { nextSendSlot } from '../../domain/mailbox/window-policy.ts';
import { addDays } from '../../domain/mailbox/zoned-time.ts';
import { MAILBOX_READINESS, type MailboxReadinessGate } from '../deliverability/ports.ts';
import { mailboxDay } from './mailbox-view.ts';
import {
  CAPACITY_COUNTERS,
  type CapacityCounters,
  MAILBOX_LIMITS,
  MAILBOX_REPOSITORY,
  type MailboxLimits,
  type MailboxRecord,
  type MailboxRepository,
  type ReserveRefusal,
} from './ports.ts';

// Which mailbox sends next, and when (BF-050) — the outbound pipeline (BF-052) calls `select`, then `reserve`
// right before sending and `commit` / `release` after. Capacity is enforced atomically in Valkey (reservations
// expire), the database keeps the daily totals.

export interface SelectInput {
  readonly organizationId: string;
  /** The thread's or business's mailbox (follow-ups come from the same sender). */
  readonly stickyMailboxId: string | null;
  readonly recipientLocale: Locale | null;
  readonly recipientTimeZone: string | null;
}

const RESERVATION_TTL_SECONDS = 15 * 60;

@Injectable()
export class MailboxCapacity {
  constructor(
    @Inject(MAILBOX_REPOSITORY) private readonly repository: MailboxRepository,
    @Inject(CAPACITY_COUNTERS) private readonly counters: CapacityCounters,
    @Inject(MAILBOX_LIMITS) private readonly limits: MailboxLimits,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(MAILBOX_READINESS) private readonly readiness?: MailboxReadinessGate,
  ) {}

  /** BF-056: a mailbox whose domain fails authentication (without an owner's override) does not send. */
  private async ready(mailbox: MailboxRecord) {
    return this.readiness ? this.readiness.isReady(mailbox.organizationId, mailbox.id, mailbox.email) : true;
  }

  async select(input: SelectInput, random: () => number = Math.random): Promise<MailboxSelection> {
    const now = this.clock.now();
    const mailboxes = (await this.repository.list(input.organizationId)).filter(
      (m) => m.disconnectedAt === null,
    );
    if (input.stickyMailboxId) {
      const sticky = mailboxes.find((mailbox) => mailbox.id === input.stickyMailboxId);
      // A paused or failed sender: the thread waits (or a person reassigns it); never a silent switch.
      if (!sticky || !canSend(sticky.status) || !(await this.ready(sticky)))
        return { ok: false, reason: 'STICKY_UNAVAILABLE', nextAvailableAt: null };
      const slot = await this.slot(sticky, input, now, random);
      return slot
        ? { ok: true, mailboxId: sticky.id, sendAt: slot.toISOString(), sticky: true }
        : { ok: false, reason: 'NO_CAPACITY', nextAvailableAt: null };
    }
    if (mailboxes.length === 0) return { ok: false, reason: 'NO_MAILBOX', nextAvailableAt: null };
    const bounceRates = await this.repository.bounceRates(
      input.organizationId,
      new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10),
    );
    const candidates: MailboxCandidate[] = await Promise.all(
      mailboxes.map(async (mailbox) => {
        const usage = await this.counters.today(mailbox.id, mailboxDay(mailbox, now));
        return {
          id: mailbox.id,
          status: mailbox.status,
          locales: mailbox.locales,
          effectiveCap: effectiveCap(mailbox, now),
          used: (usage?.sent ?? 0) + (usage?.reserved ?? 0),
          bounceRate: bounceRates.get(mailbox.id) ?? 0,
          lastSelectedAt: mailbox.lastSelectedAt,
        };
      }),
    );
    const ranked = rank(candidates, input.recipientLocale, now);
    for (const candidate of ranked) {
      const mailbox = mailboxes.find((m) => m.id === candidate.id);
      if (!mailbox || !(await this.ready(mailbox))) continue;
      const slot = await this.slot(mailbox, input, now, random);
      if (!slot) continue;
      await this.repository.update(input.organizationId, mailbox.id, { lastSelectedAt: now });
      return { ok: true, mailboxId: mailbox.id, sendAt: slot.toISOString(), sticky: false };
    }
    // Everyone is full today: the earliest window opening tomorrow among the mailboxes that can send.
    const tomorrow = mailboxes
      .filter((mailbox) => canSend(mailbox.status))
      .map((mailbox) =>
        nextSendSlot({
          window: mailbox.window,
          recipientTimeZone: input.recipientTimeZone,
          now: new Date(now.getTime() + 86_400_000),
          lastSentAt: null,
          minIntervalSec: mailbox.minIntervalSec,
          random,
        }),
      )
      .filter((slot): slot is Date => slot !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    return { ok: false, reason: 'NO_CAPACITY', nextAvailableAt: tomorrow?.toISOString() ?? null };
  }

  /**
   * Holds one send of the mailbox's capacity (and the workspace's and the recipient domain's) until it is
   * committed or released, or expires after 15 minutes.
   */
  async reserve(
    mailbox: MailboxRecord,
    recipientEmail: string,
  ): Promise<{ ok: true; token: string } | { ok: false; reason: Exclude<ReserveRefusal, 'UNSEEDED'> }> {
    const now = this.clock.now();
    const day = mailboxDay(mailbox, now);
    const input = {
      organizationId: mailbox.organizationId,
      mailboxId: mailbox.id,
      day,
      cap: effectiveCap(mailbox, now),
      workspaceDay: now.toISOString().slice(0, 10),
      workspaceCap: this.limits.workspaceDailyCap,
      recipientDomain: (recipientEmail.split('@')[1] ?? '').toLowerCase(),
      domainHour: now.toISOString().slice(0, 13),
      domainLimit: this.limits.domainHourlyLimit,
      ttlSeconds: RESERVATION_TTL_SECONDS,
    };
    let result = await this.counters.reserve(input);
    if (!result.ok && result.reason === 'UNSEEDED') {
      const [row] = await this.repository.usage(mailbox.id, day, day);
      await this.counters.seed(mailbox.id, day, row?.sent ?? 0);
      result = await this.counters.reserve(input);
    }
    if (result.ok) return result;
    return { ok: false, reason: result.reason === 'UNSEEDED' ? 'MAILBOX_CAP' : result.reason };
  }

  /** After the provider accepted the message (idempotent per token). */
  async commit(token: string): Promise<void> {
    const committed = await this.counters.commit(token);
    if (!committed) return;
    await this.repository.addUsage(committed.mailboxId, committed.day, { sent: 1 });
    await this.counters.noteSent(committed.mailboxId, this.clock.now());
  }

  /** The send did not happen (it failed before the provider accepted it: count it with `record('failed')`). */
  async release(token: string): Promise<void> {
    await this.counters.release(token);
  }

  /** Bounces, complaints and replies are counted on the day they arrive (BF-054/BF-056 call this). */
  async record(mailbox: MailboxRecord, kind: 'failed' | 'bounced' | 'complaints' | 'replies'): Promise<void> {
    await this.repository.addUsage(mailbox.id, mailboxDay(mailbox, this.clock.now()), { [kind]: 1 });
  }

  private async slot(mailbox: MailboxRecord, input: SelectInput, now: Date, random: () => number) {
    const day = mailboxDay(mailbox, now);
    const usage = await this.counters.today(mailbox.id, day);
    const cap = effectiveCap(mailbox, now);
    const lastSentAt = await this.counters.lastSentAt(mailbox.id);
    const full = (usage?.sent ?? 0) + (usage?.reserved ?? 0) >= cap;
    // Full today: the first slot of the next day in the mailbox's timezone.
    const from = full ? new Date(Date.parse(`${addDays(day, 1)}T00:00:00Z`)) : now;
    return nextSendSlot({
      window: mailbox.window,
      recipientTimeZone: input.recipientTimeZone,
      now: from.getTime() > now.getTime() ? from : now,
      lastSentAt,
      minIntervalSec: mailbox.minIntervalSec,
      random,
    });
  }
}
