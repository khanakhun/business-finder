import { type DbClient, getExecutor } from '@bf/db';
import { manualContactLogs, outboundMessages } from '@bf/db/schema';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, count, eq, inArray, isNotNull, lt, ne } from 'drizzle-orm';
import {
  type DataSubjectQuery,
  type PersonalDataProvider,
  PersonalDataRegistry,
  RetentionRegistry,
} from '../../../compliance/index.ts';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';

// Outbound email holds the recipient's address and what we wrote to them (BF-052, data map: bodies 24 months). The
// DSR provider exports and erases messages sent to an address; erasure keeps the row (status, dates, the compliance
// decisions it references: the legally required minimal log) and removes the address and the content. Manual
// contact logs are free text written by a person: listed for review, never erased automatically.

const RETENTION_DAYS = 730;
const ERASED = '[erased]';

const erasedContent = { toEmail: null, subject: ERASED, bodyText: ERASED, bodyHtml: ERASED, headers: {} };

@Injectable()
export class OutboundPersonalData implements PersonalDataProvider, OnModuleInit {
  readonly id = 'outreach.outbound';
  readonly categories = ['contact_details', 'message_content'] as const;

  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    private readonly personalData: PersonalDataRegistry,
    private readonly retention: RetentionRegistry,
  ) {}

  onModuleInit() {
    this.personalData.register(this);
    this.personalData.register(new ManualLogPersonalData(this.db));
    const cutoff = (now: Date) => new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
    const due = (now: Date) =>
      and(lt(outboundMessages.createdAt, cutoff(now)), ne(outboundMessages.bodyText, ERASED));
    this.retention.register({
      id: 'outreach.outbound',
      entity: 'outbound_messages',
      description: `Outbound email bodies and recipient addresses after ${RETENTION_DAYS} days (the row and its compliance decisions stay).`,
      retentionDays: RETENTION_DAYS,
      action: 'anonymize',
      count: async (now) => {
        const [row] = await this.db.select({ n: count() }).from(outboundMessages).where(due(now));
        return Number(row?.n ?? 0);
      },
      apply: async (now, limit) => {
        const ids = await this.db
          .select({ id: outboundMessages.id })
          .from(outboundMessages)
          .where(due(now))
          .limit(limit);
        if (ids.length === 0) return 0;
        const done = await this.db
          .update(outboundMessages)
          .set(erasedContent)
          .where(
            inArray(
              outboundMessages.id,
              ids.map((row) => row.id),
            ),
          )
          .returning({ id: outboundMessages.id });
        return done.length;
      },
    });
    const logsDue = (now: Date) =>
      and(lt(manualContactLogs.createdAt, cutoff(now)), ne(manualContactLogs.summary, ERASED));
    this.retention.register({
      id: 'outreach.manual-logs',
      entity: 'manual_contact_logs',
      description: `Manual contact summaries after ${RETENTION_DAYS} days (the log and its decision stay).`,
      retentionDays: RETENTION_DAYS,
      action: 'anonymize',
      count: async (now) => {
        const [row] = await this.db.select({ n: count() }).from(manualContactLogs).where(logsDue(now));
        return Number(row?.n ?? 0);
      },
      apply: async (now, limit) => {
        const ids = await this.db
          .select({ id: manualContactLogs.id })
          .from(manualContactLogs)
          .where(logsDue(now))
          .limit(limit);
        if (ids.length === 0) return 0;
        const done = await this.db
          .update(manualContactLogs)
          .set({ summary: ERASED, outcome: null })
          .where(
            inArray(
              manualContactLogs.id,
              ids.map((row) => row.id),
            ),
          )
          .returning({ id: manualContactLogs.id });
        return done.length;
      },
    });
  }

  async find(subject: DataSubjectQuery) {
    if (!subject.email) return [];
    const rows = await getExecutor(this.db)
      .select({
        id: outboundMessages.id,
        status: outboundMessages.status,
        createdAt: outboundMessages.createdAt,
      })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.organizationId, subject.organizationId),
          eq(outboundMessages.toEmail, subject.email),
        ),
      );
    return rows.map((row) => ({
      id: row.id,
      summary: `${row.status} email of ${row.createdAt.toISOString().slice(0, 10)}`,
    }));
  }

  async export(_subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    if (refs.length === 0) return [];
    const rows = await getExecutor(this.db)
      .select({
        to: outboundMessages.toEmail,
        subject: outboundMessages.subject,
        body: outboundMessages.bodyText,
        status: outboundMessages.status,
        scheduledAt: outboundMessages.scheduledAt,
        sentAt: outboundMessages.sentAt,
        createdAt: outboundMessages.createdAt,
      })
      .from(outboundMessages)
      .where(
        inArray(
          outboundMessages.id,
          refs.map((ref) => ref.id),
        ),
      );
    return [{ name: 'outbound_emails', rows }];
  }

  /** Both modes anonymize: the message row is the evidence of what was decided and when. */
  async erase(_subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    if (refs.length === 0) return { erased: 0, manual: 0 };
    const done = await getExecutor(this.db)
      .update(outboundMessages)
      .set(erasedContent)
      .where(
        and(
          inArray(
            outboundMessages.id,
            refs.map((ref) => ref.id),
          ),
          isNotNull(outboundMessages.toEmail),
        ),
      )
      .returning({ id: outboundMessages.id });
    return { erased: done.length, manual: 0 };
  }
}

/** Manual contact logs of the subject's business: free text, so a person reviews them. */
class ManualLogPersonalData implements PersonalDataProvider {
  readonly id = 'outreach.manual-logs';
  readonly categories = ['message_content'] as const;
  readonly manualReview = true;

  constructor(private readonly db: DbClient) {}

  async find(subject: DataSubjectQuery) {
    if (!subject.businessId) return [];
    const rows = await getExecutor(this.db)
      .select({
        id: manualContactLogs.id,
        channel: manualContactLogs.channel,
        createdAt: manualContactLogs.createdAt,
      })
      .from(manualContactLogs)
      .where(
        and(
          eq(manualContactLogs.organizationId, subject.organizationId),
          eq(manualContactLogs.businessId, subject.businessId),
        ),
      );
    return rows.map((row) => ({
      id: row.id,
      summary: `${row.channel} contact of ${row.createdAt.toISOString().slice(0, 10)}`,
    }));
  }

  async export(_subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    if (refs.length === 0) return [];
    const rows = await getExecutor(this.db)
      .select({
        channel: manualContactLogs.channel,
        summary: manualContactLogs.summary,
        outcome: manualContactLogs.outcome,
        createdAt: manualContactLogs.createdAt,
      })
      .from(manualContactLogs)
      .where(
        inArray(
          manualContactLogs.id,
          refs.map((ref) => ref.id),
        ),
      );
    return [{ name: 'manual_contact_logs', rows }];
  }

  async erase(_subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    return { erased: 0, manual: refs.length };
  }
}
