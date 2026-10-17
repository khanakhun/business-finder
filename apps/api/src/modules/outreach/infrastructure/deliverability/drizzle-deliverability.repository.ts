import type { DomainCheck } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import {
  deliverabilityDomains,
  deliverabilitySettings,
  inboundMessages,
  mailboxDailyUsage,
  mailboxReadinessOverrides,
  outboundMessages,
  unsubscribeTokens,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, inArray, type SQL, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type { DeliverabilityRepository, ReadinessOverride } from '../../application/deliverability/ports.ts';

@Injectable()
export class DrizzleDeliverabilityRepository implements DeliverabilityRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async domainCheck(organizationId: string, domain: string) {
    const [row] = await this.x
      .select()
      .from(deliverabilityDomains)
      .where(
        and(
          eq(deliverabilityDomains.organizationId, organizationId),
          eq(deliverabilityDomains.domain, domain),
        ),
      );
    return row
      ? ({
          domain: row.domain,
          provider: row.provider,
          outcome: row.outcome,
          checks: row.checks,
          checkedAt: row.checkedAt.toISOString(),
        } satisfies DomainCheck)
      : undefined;
  }

  async saveDomainCheck(organizationId: string, check: DomainCheck) {
    const values = {
      provider: check.provider,
      outcome: check.outcome,
      checks: check.checks,
      checkedAt: new Date(check.checkedAt),
    };
    await this.x
      .insert(deliverabilityDomains)
      .values({ organizationId, domain: check.domain, ...values })
      .onConflictDoUpdate({
        target: [deliverabilityDomains.organizationId, deliverabilityDomains.domain],
        set: values,
      });
  }

  async overrides(organizationId: string) {
    return (await this.x
      .select()
      .from(mailboxReadinessOverrides)
      .where(eq(mailboxReadinessOverrides.organizationId, organizationId))) as ReadinessOverride[];
  }

  async override(organizationId: string, mailboxId: string) {
    const [row] = await this.x
      .select()
      .from(mailboxReadinessOverrides)
      .where(
        and(
          eq(mailboxReadinessOverrides.organizationId, organizationId),
          eq(mailboxReadinessOverrides.mailboxId, mailboxId),
        ),
      );
    return row as ReadinessOverride | undefined;
  }

  async setOverride(organizationId: string, mailboxId: string, reason: string, by: string | null) {
    await this.x
      .insert(mailboxReadinessOverrides)
      .values({ organizationId, mailboxId, reason, createdBy: by })
      .onConflictDoUpdate({
        target: mailboxReadinessOverrides.mailboxId,
        set: { reason, createdBy: by, createdAt: new Date() },
      });
  }

  async clearOverride(organizationId: string, mailboxId: string) {
    const rows = await this.x
      .delete(mailboxReadinessOverrides)
      .where(
        and(
          eq(mailboxReadinessOverrides.organizationId, organizationId),
          eq(mailboxReadinessOverrides.mailboxId, mailboxId),
        ),
      )
      .returning({ id: mailboxReadinessOverrides.mailboxId });
    return rows.length > 0;
  }

  async health(mailboxId: string, now: Date) {
    const day = 86_400_000;
    const since24h = new Date(now.getTime() - day);
    const since7d = new Date(now.getTime() - 7 * day);
    const since30d = new Date(now.getTime() - 30 * day).toISOString().slice(0, 10);
    const SENT = ['sent', 'replied', 'bounced'] as const;
    const last50 = await this.x
      .select({ status: outboundMessages.status })
      .from(outboundMessages)
      .where(and(eq(outboundMessages.mailboxId, mailboxId), inArray(outboundMessages.status, [...SENT])))
      .orderBy(desc(outboundMessages.sentAt))
      .limit(50);
    const sendsSince = async (since: Date) => {
      const [row] = await this.x
        .select({ n: count() })
        .from(outboundMessages)
        .where(
          and(
            eq(outboundMessages.mailboxId, mailboxId),
            inArray(outboundMessages.status, [...SENT]),
            gte(outboundMessages.sentAt, since),
          ),
        );
      return Number(row?.n ?? 0);
    };
    const inbound = async (condition: SQL, since: Date) => {
      const [row] = await this.x
        .select({ n: count() })
        .from(inboundMessages)
        .where(
          and(eq(inboundMessages.mailboxId, mailboxId), gte(inboundMessages.receivedAt, since), condition),
        );
      return Number(row?.n ?? 0);
    };
    const triageClass = sql`coalesce(${inboundMessages.correctedClass}, ${inboundMessages.triage} ->> 'class')`;
    const [oneClick] = await this.x
      .select({ n: count() })
      .from(unsubscribeTokens)
      .innerJoin(outboundMessages, eq(outboundMessages.id, unsubscribeTokens.outboundMessageId))
      .where(and(eq(outboundMessages.mailboxId, mailboxId), gte(unsubscribeTokens.usedAt, since7d)));
    const usage = await this.x
      .select()
      .from(mailboxDailyUsage)
      .where(and(eq(mailboxDailyUsage.mailboxId, mailboxId), gte(mailboxDailyUsage.day, since30d)))
      .orderBy(mailboxDailyUsage.day);
    const since7dDay = since7d.toISOString().slice(0, 10);
    return {
      last50Sends: last50.length,
      last50Bounces: last50.filter((row) => row.status === 'bounced').length,
      bounces24h: await inbound(
        sql`${inboundMessages.kind} = 'bounce' and (${inboundMessages.dsn} ->> 'permanent') = 'true'`,
        since24h,
      ),
      sends24h: await sendsSince(since24h),
      sends7d: await sendsSince(since7d),
      unsubscribes7d:
        Number(oneClick?.n ?? 0) +
        (await inbound(sql`${inboundMessages.unsubscribeDetected} = true`, since7d)),
      negative7d: await inbound(sql`${triageClass} = 'negative'`, since7d),
      positive7d: await inbound(sql`${triageClass} in ('interested', 'question')`, since7d),
      autoReplies7d: await inbound(sql`${inboundMessages.kind} = 'auto_reply'`, since7d),
      deferrals7d: usage.filter((row) => row.day >= since7dDay).reduce((sum, row) => sum + row.failed, 0),
      daily: usage.map((row) => ({
        day: row.day,
        sent: row.sent,
        bounced: row.bounced,
        replies: row.replies,
        failed: row.failed,
      })),
    };
  }

  async mailboxOfMessage(messageId: string) {
    const [row] = await this.x
      .select({ organizationId: outboundMessages.organizationId, mailboxId: outboundMessages.mailboxId })
      .from(outboundMessages)
      .where(eq(outboundMessages.id, messageId));
    return row?.mailboxId ? { organizationId: row.organizationId, mailboxId: row.mailboxId } : undefined;
  }

  async killSwitch(organizationId: string) {
    const [row] = await this.x
      .select()
      .from(deliverabilitySettings)
      .where(eq(deliverabilitySettings.organizationId, organizationId));
    return {
      active: row?.killSwitch ?? false,
      reason: row?.killReason ?? null,
      by: row?.killBy ?? null,
      at: row?.killAt ?? null,
    };
  }

  async setKillSwitch(organizationId: string, active: boolean, reason: string, by: string | null) {
    const values = {
      killSwitch: active,
      killReason: reason,
      killBy: by,
      killAt: new Date(),
      updatedAt: new Date(),
    };
    await this.x
      .insert(deliverabilitySettings)
      .values({ organizationId, ...values })
      .onConflictDoUpdate({ target: deliverabilitySettings.organizationId, set: values });
  }
}
