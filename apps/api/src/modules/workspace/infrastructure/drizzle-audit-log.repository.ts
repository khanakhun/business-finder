import { type DbClient, getExecutor } from '@bf/db';
import { auditLogs } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, like, lte, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  AuditEntryRecord,
  AuditLogFilter,
  AuditLogRepository,
  NewAuditEntry,
} from '../application/ports.ts';

/** `LIKE` prefix with its wildcards escaped (`_` is common in action names). */
const prefixPattern = (prefix: string) => `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

@Injectable()
export class DrizzleAuditLogRepository implements AuditLogRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async insert(entry: NewAuditEntry): Promise<void> {
    await getExecutor(this.db).insert(auditLogs).values(entry);
  }

  async list(filter: AuditLogFilter): Promise<AuditEntryRecord[]> {
    const rows = await getExecutor(this.db)
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, filter.organizationId),
          filter.action ? like(auditLogs.action, prefixPattern(filter.action)) : undefined,
          filter.actorId ? eq(auditLogs.actorId, filter.actorId) : undefined,
          filter.entityType ? eq(auditLogs.entityType, filter.entityType) : undefined,
          filter.entityId ? eq(auditLogs.entityId, filter.entityId) : undefined,
          filter.from ? gte(auditLogs.occurredAt, new Date(filter.from)) : undefined,
          filter.to ? lte(auditLogs.occurredAt, new Date(filter.to)) : undefined,
          filter.before
            ? sql`(${auditLogs.occurredAt}, ${auditLogs.id}) < (${filter.before.occurredAt.toISOString()}::timestamptz, ${filter.before.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
      .limit(filter.limit);
    return rows;
  }
}
