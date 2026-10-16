import type { CategoryAttributes } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { businesses, websiteAudits } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { AuditBusinessFacts, WebsiteAuditRecord, WebsiteAuditRepository } from '../application/ports.ts';

type Row = typeof websiteAudits.$inferSelect;

const toRecord = (row: Row): WebsiteAuditRecord => ({
  id: row.id,
  businessId: row.businessId,
  snapshotId: row.snapshotId,
  psi: row.psi ?? null,
  vision: row.vision ?? null,
  findings: row.findings,
  qualityScore: row.qualityScore,
  websiteStatus: row.websiteStatus,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Website audits (BF-030). The business facts are read from business-graph tables (read-only).
 * DECISION(BF-030): like the enrichment subject reader, a cross-module read model; writes stay in this module's table.
 */
@Injectable()
export class DrizzleWebsiteAuditRepository implements WebsiteAuditRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async lockForSnapshot(businessId: string, snapshotId: string): Promise<WebsiteAuditRecord | undefined> {
    const x = getExecutor(this.db);
    // A missing row cannot be locked: the advisory lock serializes the two steps writing the same snapshot.
    await x.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`website-audit:${snapshotId}`}, 0))`);
    const [row] = await x
      .select()
      .from(websiteAudits)
      .where(and(eq(websiteAudits.snapshotId, snapshotId), eq(websiteAudits.businessId, businessId)));
    return row ? toRecord(row) : undefined;
  }

  async save(audit: Omit<WebsiteAuditRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<WebsiteAuditRecord> {
    const x = getExecutor(this.db);
    const values = {
      psi: audit.psi,
      vision: audit.vision,
      findings: audit.findings,
      qualityScore: audit.qualityScore,
      websiteStatus: audit.websiteStatus,
      isLatest: true,
    };
    const [row] = await x
      .insert(websiteAudits)
      .values({ businessId: audit.businessId, snapshotId: audit.snapshotId, ...values })
      .onConflictDoUpdate({ target: websiteAudits.snapshotId, set: values })
      .returning();
    // The audited snapshot is the business's newest (steps run right after the crawl): earlier audits step aside.
    await x
      .update(websiteAudits)
      .set({ isLatest: false })
      .where(
        and(
          eq(websiteAudits.businessId, audit.businessId),
          ne(websiteAudits.snapshotId, audit.snapshotId),
          eq(websiteAudits.isLatest, true),
        ),
      );
    return toRecord(row as Row);
  }

  async latest(businessId: string): Promise<WebsiteAuditRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(websiteAudits)
      .where(and(eq(websiteAudits.businessId, businessId), eq(websiteAudits.isLatest, true)))
      .limit(1);
    return row ? toRecord(row) : undefined;
  }

  async businessFacts(businessId: string): Promise<AuditBusinessFacts> {
    const x = getExecutor(this.db);
    const [business] = await x
      .select({ countryCode: businesses.countryCode })
      .from(businesses)
      .where(eq(businesses.id, businessId));
    // The primary category's attributes merged from the root down (a child overrides its ancestors).
    const rows = await x.execute<{
      attributes: CategoryAttributes;
      root: string;
      label: string | null;
      leaf: boolean;
    }>(
      sql`SELECT anc.attributes, subpath(leaf.path, 0, 1)::text AS root,
            leaf.labels->>'en' AS label, anc.id = leaf.id AS leaf
          FROM business_categories bc
          JOIN categories leaf ON leaf.id = bc.category_id
          JOIN categories anc ON anc.path @> leaf.path
          WHERE bc.business_id = ${businessId} AND bc.is_primary
          ORDER BY nlevel(anc.path)`,
    );
    const attributes = Object.assign({}, ...rows.map((row) => row.attributes ?? {})) as CategoryAttributes;
    return {
      countryCode: business?.countryCode ?? null,
      categoryAttributes: attributes,
      servesFood: rows[0]?.root === 'food_drink',
      categoryLabel: rows[0]?.label ?? null,
    };
  }
}
