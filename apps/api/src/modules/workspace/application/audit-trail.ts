import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_LOG_REPOSITORY, type AuditEntryRecord, type AuditLogRepository } from './ports.ts';

/** Read side of the audit log for other modules (public surface): e.g. a recorded acknowledgement. */
@Injectable()
export class AuditTrail {
  constructor(@Inject(AUDIT_LOG_REPOSITORY) private readonly repository: AuditLogRepository) {}

  /** The workspace's most recent entry whose action starts with `actionPrefix`, if any. */
  async latest(organizationId: string, actionPrefix: string): Promise<AuditEntryRecord | undefined> {
    const [entry] = await this.repository.list({ organizationId, action: actionPrefix, limit: 1 });
    return entry;
  }
}
