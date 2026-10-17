import type { DomainCheck } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { deliverabilityDomains, mailboxReadinessOverrides } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
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
}
