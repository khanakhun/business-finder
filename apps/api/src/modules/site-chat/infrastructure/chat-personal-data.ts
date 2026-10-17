import { type DbClient, getExecutor } from '@bf/db';
import { siteChatMessages, siteChatThreads } from '@bf/db/schema';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, count, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  type DataSubjectQuery,
  type PersonalDataProvider,
  PersonalDataRegistry,
  RetentionRegistry,
} from '../../compliance/index.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import { SITE_CHAT_REPOSITORY, type SiteChatRepository } from '../application/ports.ts';
import { SITE_CHAT_RETENTION_DAYS } from '../application/site-chat.retention.ts';

// Site chat messages may quote a person's address or phone (BF-055): found by text search, erased by replacing the
// identifier in the message parts. And the chat retention (180 days) as a policy of the compliance engine.

@Injectable()
export class ChatPersonalData implements PersonalDataProvider, OnModuleInit {
  readonly id = 'sites.chat_messages';
  readonly categories = ['message_content'] as const;

  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(SITE_CHAT_REPOSITORY) private readonly repository: SiteChatRepository,
    @Inject(SITE_CHAT_RETENTION_DAYS) private readonly days: number,
    private readonly personalData: PersonalDataRegistry,
    private readonly retention: RetentionRegistry,
  ) {}

  onModuleInit() {
    this.personalData.register(this);
    const cutoff = (now: Date) => new Date(now.getTime() - this.days * 86_400_000);
    this.retention.register({
      id: 'sites.chat_threads',
      entity: 'site_chat_threads',
      description: `Site chat threads (messages and proposals) ${this.days} days after their last activity.`,
      retentionDays: this.days,
      action: 'delete',
      count: async (now) => {
        const [row] = await this.db
          .select({ n: count() })
          .from(siteChatThreads)
          .where(lt(siteChatThreads.updatedAt, cutoff(now)));
        return Number(row?.n ?? 0);
      },
      apply: (now, limit) => this.repository.deleteThreadsBefore(cutoff(now), limit),
    });
  }

  private needles(subject: DataSubjectQuery) {
    return [subject.email, subject.phone].filter((value): value is string =>
      Boolean(value && value.length >= 5),
    );
  }

  async find(subject: DataSubjectQuery) {
    const needles = this.needles(subject);
    if (needles.length === 0) return [];
    const rows = await getExecutor(this.db)
      .select({ id: siteChatMessages.id, createdAt: siteChatMessages.createdAt })
      .from(siteChatMessages)
      .innerJoin(siteChatThreads, eq(siteChatThreads.id, siteChatMessages.threadId))
      .where(
        and(
          eq(siteChatThreads.organizationId, subject.organizationId),
          sql`(${sql.join(
            needles.map(
              (needle) => sql`position(lower(${needle}) in lower(${siteChatMessages.parts}::text)) > 0`,
            ),
            sql` OR `,
          )})`,
        ),
      )
      .limit(500);
    return rows.map((row) => ({
      id: row.id,
      summary: `chat message of ${row.createdAt.toISOString().slice(0, 10)}`,
    }));
  }

  async export(_subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    const rows = await getExecutor(this.db)
      .select({
        role: siteChatMessages.role,
        parts: siteChatMessages.parts,
        createdAt: siteChatMessages.createdAt,
      })
      .from(siteChatMessages)
      .where(
        inArray(
          siteChatMessages.id,
          refs.map((ref) => ref.id),
        ),
      );
    return [{ name: 'site_chat_messages', rows }];
  }

  /** Replaces the identifiers in the messages (both modes: the conversation's other content is not personal). */
  async erase(subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    const needles = this.needles(subject);
    if (refs.length === 0 || needles.length === 0) return { erased: 0, manual: 0 };
    let text = sql`${siteChatMessages.parts}::text`;
    for (const needle of needles) text = sql`replace(${text}, ${needle}, '[erased]')`;
    const updated = await getExecutor(this.db)
      .update(siteChatMessages)
      .set({ parts: sql`(${text})::jsonb` })
      .where(
        inArray(
          siteChatMessages.id,
          refs.map((ref) => ref.id),
        ),
      )
      .returning({ id: siteChatMessages.id });
    return { erased: updated.length, manual: 0 };
  }
}
