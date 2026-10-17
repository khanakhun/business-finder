import { type DbClient, getExecutor } from '@bf/db';
import { siteDomains } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { DomainRecord, DomainRepository } from '../application/go-live/ports.ts';

const CLAIM_MS = 5 * 60_000;

/** Custom domains (BF-062). */
@Injectable()
export class DrizzleDomainRepository implements DomainRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async forSite(organizationId: string, siteId: string) {
    return (await getExecutor(this.db)
      .select()
      .from(siteDomains)
      .where(and(eq(siteDomains.organizationId, organizationId), eq(siteDomains.siteId, siteId)))
      .orderBy(asc(siteDomains.createdAt))) as DomainRecord[];
  }

  async byHostname(hostname: string) {
    const [row] = await getExecutor(this.db)
      .select()
      .from(siteDomains)
      .where(eq(siteDomains.hostname, hostname.toLowerCase()));
    return row as DomainRecord | undefined;
  }

  async insert(rows: Parameters<DomainRepository['insert']>[0]) {
    if (rows.length)
      await getExecutor(this.db)
        .insert(siteDomains)
        .values([...rows]);
  }

  async update(id: string, patch: Parameters<DomainRepository['update']>[1]) {
    await getExecutor(this.db)
      .update(siteDomains)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(siteDomains.id, id));
  }

  async claimDue(now: Date, limit: number) {
    const rows = await getExecutor(this.db).execute<{ id: string }>(sql`
      UPDATE site_domains SET next_check_at = ${new Date(now.getTime() + CLAIM_MS).toISOString()}::timestamptz
      WHERE id IN (
        SELECT id FROM site_domains
        WHERE status IN ('pending_dns', 'verifying') AND next_check_at <= ${now.toISOString()}::timestamptz
        ORDER BY next_check_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id`);
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    return (await getExecutor(this.db)
      .select()
      .from(siteDomains)
      .where(
        sql`${siteDomains.id} IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
      )) as DomainRecord[];
  }
}
