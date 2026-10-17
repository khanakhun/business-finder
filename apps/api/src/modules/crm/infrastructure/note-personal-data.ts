import { type DbClient, getExecutor } from '@bf/db';
import { notes, tasks } from '@bf/db/schema';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  type DataSubjectQuery,
  type PersonalDataProvider,
  PersonalDataRegistry,
} from '../../compliance/index.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';

// Notes and tasks are free text written by teammates (BF-055): ones that mention the subject's address, phone or name
// are listed for a person to review and edit — never rewritten automatically.

@Injectable()
export class NotePersonalData implements PersonalDataProvider, OnModuleInit {
  readonly id = 'crm.notes_and_tasks';
  readonly categories = ['free_text'] as const;
  readonly manualReview = true;

  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    private readonly registry: PersonalDataRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  private needles(subject: DataSubjectQuery) {
    return [subject.email, subject.phone, subject.name].filter((value): value is string =>
      Boolean(value && value.length >= 3),
    );
  }

  private mentions(column: typeof notes.bodyMarkdown | typeof tasks.title, needles: string[]) {
    return sql`(${sql.join(
      needles.map((needle) => sql`position(lower(${needle}) in lower(${column})) > 0`),
      sql` OR `,
    )})`;
  }

  async find(subject: DataSubjectQuery) {
    const needles = this.needles(subject);
    if (needles.length === 0) return [];
    const x = getExecutor(this.db);
    const [noteRows, taskRows] = await Promise.all([
      x
        .select({ id: notes.id, businessId: notes.businessId })
        .from(notes)
        .where(
          and(eq(notes.organizationId, subject.organizationId), this.mentions(notes.bodyMarkdown, needles)),
        )
        .limit(200),
      x
        .select({ id: tasks.id, businessId: tasks.businessId })
        .from(tasks)
        .where(and(eq(tasks.organizationId, subject.organizationId), this.mentions(tasks.title, needles)))
        .limit(200),
    ]);
    return [
      ...noteRows.map((row) => ({
        id: `note:${row.id}`,
        summary: `note on business ${row.businessId.slice(0, 8)}`,
      })),
      ...taskRows.map((row) => ({
        id: `task:${row.id}`,
        summary: `task on business ${String(row.businessId).slice(0, 8)}`,
      })),
    ];
  }

  async export(_subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    const noteIds = refs.filter((ref) => ref.id.startsWith('note:')).map((ref) => ref.id.slice(5));
    const taskIds = refs.filter((ref) => ref.id.startsWith('task:')).map((ref) => ref.id.slice(5));
    const x = getExecutor(this.db);
    const [noteRows, taskRows] = await Promise.all([
      noteIds.length
        ? x
            .select({ body: notes.bodyMarkdown, createdAt: notes.createdAt })
            .from(notes)
            .where(inArray(notes.id, noteIds))
        : [],
      taskIds.length
        ? x
            .select({ title: tasks.title, createdAt: tasks.createdAt })
            .from(tasks)
            .where(inArray(tasks.id, taskIds))
        : [],
    ]);
    return [
      { name: 'notes', rows: noteRows },
      { name: 'tasks', rows: taskRows },
    ];
  }

  /** Never automatic: the trail lists them for review. */
  async erase(_subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    return { erased: 0, manual: refs.length };
  }
}
