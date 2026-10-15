import {
  type AuditLogPage,
  type AuditLogQuery,
  decodeCursor,
  encodeCursor,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { toAuditLogEntry } from './mappers.ts';
import { AUDIT_LOG_REPOSITORY, type AuditLogRepository } from './ports.ts';
import { workspaceOf } from './settings.use-cases.ts';

/** The workspace's audit log, newest first, filtered and cursor-paginated (api.md §3). */
@Injectable()
export class ListAuditLogsQuery {
  constructor(@Inject(AUDIT_LOG_REPOSITORY) private readonly repository: AuditLogRepository) {}

  async execute(auth: AuthContext, query: AuditLogQuery): Promise<AuditLogPage> {
    const { limit, cursor, ...filters } = query;
    const before = cursor ? await positionOf(cursor) : undefined;
    const rows = await this.repository.list({
      ...filters,
      organizationId: workspaceOf(auth),
      limit: limit + 1,
      ...(before ? { before } : {}),
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toAuditLogEntry),
      nextCursor:
        rows.length > limit && last
          ? await encodeCursor({ sort: [last.occurredAt.toISOString()], id: last.id })
          : null,
    };
  }
}

async function positionOf(cursor: string): Promise<{ occurredAt: Date; id: string }> {
  const data = await decodeCursor(cursor);
  const [at] = data.sort;
  const occurredAt = typeof at === 'string' ? new Date(at) : undefined;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) {
    throw new ValidationError('Invalid cursor.', [{ path: ['cursor'], message: 'Invalid cursor' }]);
  }
  return { occurredAt, id: data.id };
}
