import { type DbClient, getExecutor } from '@bf/db';
import { siteLeads } from '@bf/db/schema';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, count, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  type DataSubjectQuery,
  type PersonalDataProvider,
  PersonalDataRegistry,
  RetentionRegistry,
} from '../../compliance/index.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import { LEADS_RETENTION } from '../application/leads.retention.ts';
import { LEADS_REPOSITORY, type LeadsRepository } from '../application/ports.ts';

// Preview leads hold names, addresses, phone numbers and messages (BF-055): the DSR provider, and the retention policy
// (24 months, spam 30 days) run by the compliance retention engine.

@Injectable()
export class LeadPersonalData implements PersonalDataProvider, OnModuleInit {
  readonly id = 'sites.leads';
  readonly categories = ['contact_details', 'names', 'message_content'] as const;

  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(LEADS_REPOSITORY) private readonly repository: LeadsRepository,
    @Inject(LEADS_RETENTION) private readonly days: { readonly leads: number; readonly spam: number },
    private readonly personalData: PersonalDataRegistry,
    private readonly retention: RetentionRegistry,
  ) {}

  onModuleInit() {
    this.personalData.register(this);
    const cutoffs = (now: Date) => ({
      before: new Date(now.getTime() - this.days.leads * 86_400_000),
      spamBefore: new Date(now.getTime() - this.days.spam * 86_400_000),
    });
    this.retention.register({
      id: 'sites.leads',
      entity: 'site_leads',
      description: `Preview leads after ${this.days.leads} days, spam after ${this.days.spam} days.`,
      retentionDays: this.days.leads,
      action: 'delete',
      count: async (now) => {
        const { before, spamBefore } = cutoffs(now);
        const [row] = await this.db
          .select({ n: count() })
          .from(siteLeads)
          .where(
            or(
              lt(siteLeads.createdAt, before),
              and(eq(siteLeads.status, 'spam'), lt(siteLeads.createdAt, spamBefore)),
            ),
          );
        return Number(row?.n ?? 0);
      },
      apply: (now, limit) => {
        const { before, spamBefore } = cutoffs(now);
        return this.repository.deleteBefore(before, spamBefore, limit);
      },
    });
  }

  private match(subject: DataSubjectQuery) {
    const keys = [
      subject.email ? eq(siteLeads.email, subject.email) : undefined,
      subject.phone
        ? or(eq(siteLeads.phone, subject.phone), eq(siteLeads.whatsapp, subject.phone))
        : undefined,
    ].filter((key) => key !== undefined);
    return keys.length === 0 ? null : and(eq(siteLeads.organizationId, subject.organizationId), or(...keys));
  }

  async find(subject: DataSubjectQuery) {
    const where = this.match(subject);
    if (!where) return [];
    const rows = await getExecutor(this.db)
      .select({ id: siteLeads.id, kind: siteLeads.kind, createdAt: siteLeads.createdAt })
      .from(siteLeads)
      .where(where);
    return rows.map((row) => ({
      id: row.id,
      summary: `${row.kind} lead of ${row.createdAt.toISOString().slice(0, 10)}`,
    }));
  }

  async export(_subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    const rows = await getExecutor(this.db)
      .select({
        kind: siteLeads.kind,
        name: siteLeads.name,
        email: siteLeads.email,
        phone: siteLeads.phone,
        whatsapp: siteLeads.whatsapp,
        message: siteLeads.message,
        preferredChannel: siteLeads.preferredChannel,
        consent: siteLeads.consent,
        createdAt: siteLeads.createdAt,
      })
      .from(siteLeads)
      .where(
        inArray(
          siteLeads.id,
          refs.map((ref) => ref.id),
        ),
      );
    return [{ name: 'site_leads', rows }];
  }

  async erase(_subject: DataSubjectQuery, refs: readonly { id: string }[], mode: 'delete' | 'anonymize') {
    if (refs.length === 0) return { erased: 0, manual: 0 };
    const ids = refs.map((ref) => ref.id);
    const x = getExecutor(this.db);
    const done =
      mode === 'delete'
        ? await x.delete(siteLeads).where(inArray(siteLeads.id, ids)).returning({ id: siteLeads.id })
        : await x
            .update(siteLeads)
            .set({
              name: null,
              email: null,
              phone: null,
              whatsapp: null,
              message: sql`NULL`,
              preferredTime: null,
            })
            .where(inArray(siteLeads.id, ids))
            .returning({ id: siteLeads.id });
    return { erased: done.length, manual: 0 };
  }
}
