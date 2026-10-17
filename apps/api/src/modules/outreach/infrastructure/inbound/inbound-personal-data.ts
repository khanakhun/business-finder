import { type DbClient, getExecutor } from '@bf/db';
import { inboundMessages } from '@bf/db/schema';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, count, eq, inArray, lt, ne } from 'drizzle-orm';
import {
  type DataSubjectQuery,
  type PersonalDataProvider,
  PersonalDataRegistry,
  RetentionRegistry,
} from '../../../compliance/index.ts';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';

// Replies hold the sender's address, name and what they wrote (BF-054; data map: bodies 24 months). The DSR provider
// exports and erases replies from an address; erasure keeps the row (its kind and dates: the thread's history) and
// removes the address, name and content.

const RETENTION_DAYS = 730;
const ERASED = '[erased]';
const erased = {
  fromEmail: null,
  fromName: null,
  to: [],
  cc: [],
  subject: ERASED,
  bodyText: ERASED,
  bodyHtmlSanitized: null,
  snippet: ERASED,
  attachments: [],
  triage: null,
};

@Injectable()
export class InboundPersonalData implements PersonalDataProvider, OnModuleInit {
  readonly id = 'outreach.inbound';
  readonly categories = ['contact_details', 'names', 'message_content'] as const;

  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    private readonly personalData: PersonalDataRegistry,
    private readonly retention: RetentionRegistry,
  ) {}

  onModuleInit() {
    this.personalData.register(this);
    const due = (now: Date) =>
      and(
        lt(inboundMessages.receivedAt, new Date(now.getTime() - RETENTION_DAYS * 86_400_000)),
        ne(inboundMessages.bodyText, ERASED),
      );
    this.retention.register({
      id: 'outreach.inbound',
      entity: 'inbound_messages',
      description: `Replies' addresses and content after ${RETENTION_DAYS} days (the row stays in the thread).`,
      retentionDays: RETENTION_DAYS,
      action: 'anonymize',
      count: async (now) => {
        const [row] = await this.db.select({ n: count() }).from(inboundMessages).where(due(now));
        return Number(row?.n ?? 0);
      },
      apply: async (now, limit) => {
        const ids = await this.db
          .select({ id: inboundMessages.id })
          .from(inboundMessages)
          .where(due(now))
          .limit(limit);
        if (ids.length === 0) return 0;
        const done = await this.db
          .update(inboundMessages)
          .set(erased)
          .where(
            inArray(
              inboundMessages.id,
              ids.map((row) => row.id),
            ),
          )
          .returning({ id: inboundMessages.id });
        return done.length;
      },
    });
  }

  async find(subject: DataSubjectQuery) {
    if (!subject.email) return [];
    const rows = await getExecutor(this.db)
      .select({ id: inboundMessages.id, kind: inboundMessages.kind, receivedAt: inboundMessages.receivedAt })
      .from(inboundMessages)
      .where(
        and(
          eq(inboundMessages.organizationId, subject.organizationId),
          eq(inboundMessages.fromEmail, subject.email),
        ),
      );
    return rows.map((row) => ({
      id: row.id,
      summary: `${row.kind} reply of ${row.receivedAt.toISOString().slice(0, 10)}`,
    }));
  }

  async export(_subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    if (refs.length === 0) return [];
    const rows = await getExecutor(this.db)
      .select({
        from: inboundMessages.fromEmail,
        name: inboundMessages.fromName,
        subject: inboundMessages.subject,
        body: inboundMessages.bodyText,
        kind: inboundMessages.kind,
        receivedAt: inboundMessages.receivedAt,
      })
      .from(inboundMessages)
      .where(
        inArray(
          inboundMessages.id,
          refs.map((ref) => ref.id),
        ),
      );
    return [{ name: 'inbound_emails', rows }];
  }

  /** Both modes anonymize: the reply's place in the thread stays. */
  async erase(_subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    if (refs.length === 0) return { erased: 0, manual: 0 };
    const done = await getExecutor(this.db)
      .update(inboundMessages)
      .set(erased)
      .where(
        inArray(
          inboundMessages.id,
          refs.map((ref) => ref.id),
        ),
      )
      .returning({ id: inboundMessages.id });
    return { erased: done.length, manual: 0 };
  }
}
