import type { EmailLocale } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { emailTemplates } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type { StoredTemplate, TemplateRepository } from '../../application/drafting/ports.ts';

const visibleTo = (organizationId: string) =>
  or(eq(emailTemplates.organizationId, organizationId), isNull(emailTemplates.organizationId));

@Injectable()
export class DrizzleTemplateRepository implements TemplateRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async visible(organizationId: string) {
    return (await getExecutor(this.db)
      .select()
      .from(emailTemplates)
      .where(visibleTo(organizationId))
      .orderBy(emailTemplates.key, emailTemplates.locale, desc(emailTemplates.version))) as StoredTemplate[];
  }

  async find(organizationId: string, id: string) {
    const [row] = await getExecutor(this.db)
      .select()
      .from(emailTemplates)
      .where(and(eq(emailTemplates.id, id), visibleTo(organizationId)));
    return row as StoredTemplate | undefined;
  }

  async versions(organizationId: string, key: string, locale: EmailLocale) {
    return (await getExecutor(this.db)
      .select()
      .from(emailTemplates)
      .where(and(visibleTo(organizationId), eq(emailTemplates.key, key), eq(emailTemplates.locale, locale)))
      .orderBy(desc(emailTemplates.version))) as StoredTemplate[];
  }

  async insert(row: Parameters<TemplateRepository['insert']>[0]) {
    const [stored] = await getExecutor(this.db).insert(emailTemplates).values(row).returning();
    if (!stored) throw new Error('template not stored');
    return stored as StoredTemplate;
  }

  async setStatus(organizationId: string, id: string, status: StoredTemplate['status']) {
    await getExecutor(this.db)
      .update(emailTemplates)
      .set({ status })
      .where(and(eq(emailTemplates.id, id), eq(emailTemplates.organizationId, organizationId)));
  }
}
