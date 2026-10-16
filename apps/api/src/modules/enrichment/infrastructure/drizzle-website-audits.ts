import type { CategoryAttributes } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { businesses, websiteAudits, websiteSnapshots } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
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
    // Per business: writes of one snapshot (PageSpeed, vision) and of successive snapshots never interleave, so
    // parts merge and exactly one audit stays latest. (A missing row cannot be locked with FOR UPDATE.)
    await x.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`website-audit:${businessId}`}, 0))`);
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
    };
    await x
      .insert(websiteAudits)
      .values({ businessId: audit.businessId, snapshotId: audit.snapshotId, ...values, isLatest: false })
      .onConflictDoUpdate({ target: websiteAudits.snapshotId, set: { ...values, updatedAt: sql`now()` } });
    // Latest = the audit of the business's newest crawl, whichever snapshot was written last (a re-check of an older
    // crawl never takes it back). Index-driven (snapshots by business and fetch time; the latest audit; this one) and
    // only rows whose flag changes are written: under the business lock, at most one row is latest. `newest` is never
    // empty here (the upsert above just wrote an audit of this business).
    await x.execute(sql`WITH newest AS (
        SELECT s.id FROM ${websiteSnapshots} s JOIN ${websiteAudits} a ON a.snapshot_id = s.id
        WHERE s.business_id = ${audit.businessId}
        ORDER BY s.fetched_at DESC, s.id DESC LIMIT 1)
      UPDATE ${websiteAudits} wa SET is_latest = (wa.snapshot_id = (SELECT id FROM newest))
      WHERE ((wa.business_id = ${audit.businessId} AND wa.is_latest) OR wa.snapshot_id = (SELECT id FROM newest))
        AND wa.is_latest IS DISTINCT FROM (wa.snapshot_id = (SELECT id FROM newest))`);
    const [row] = await x.select().from(websiteAudits).where(eq(websiteAudits.snapshotId, audit.snapshotId));
    return toRecord(row as Row);
  }

  async latest(businessId: string): Promise<WebsiteAuditRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(websiteAudits)
      .where(and(eq(websiteAudits.businessId, businessId), eq(websiteAudits.isLatest, true)))
      .orderBy(desc(websiteAudits.updatedAt))
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
