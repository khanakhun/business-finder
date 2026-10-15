import { type DbClient, getExecutor } from '@bf/db';
import { noSolicitationMarkers, websiteSnapshots } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  NoSolicitationMarker,
  NoSolicitationMarkers,
  StoredSiteIntel,
  WebsiteSnapshotRecord,
  WebsiteSnapshotRepository,
} from '../application/ports.ts';

/** Snapshots kept per business (data minimisation: crawled contacts are not kept forever, security.md §7). */
const KEEP_SNAPSHOTS = 3;

type SnapshotRow = typeof websiteSnapshots.$inferSelect;

const toRecord = (r: SnapshotRow): WebsiteSnapshotRecord => ({
  id: r.id,
  businessId: r.businessId,
  url: r.url,
  fetchedAt: r.fetchedAt,
  contentHash: r.contentHash,
  intel: {
    finalUrl: r.finalUrl,
    httpStatus: r.httpStatus,
    reachability: r.reachability,
    socialOnly: r.socialOnly,
    tls: r.tls,
    security: r.security,
    pages: r.pages,
    languages: r.languages,
    jsonLd: [],
    contacts: r.contacts,
    socials: r.socials,
    booking: r.booking,
    ordering: r.ordering,
    chat: r.chat,
    analytics: r.analytics,
    tech: r.tech,
    freshness: r.freshness,
    mobile: r.mobile,
    performanceHints: r.performanceHints,
    links: r.links,
    noSolicitation: r.noSolicitation,
    logoCandidates: r.logoCandidates,
    imageCandidates: r.imageCandidates,
    screenshots: { desktopKey: r.screenshotDesktopKey, mobileKey: r.screenshotMobileKey, fullPageKey: null },
    warnings: r.warnings,
  },
});

/** Website snapshots (global facts, BF-027). JSON-LD is not kept: what it said went through ingestion. */
@Injectable()
export class DrizzleWebsiteSnapshotRepository implements WebsiteSnapshotRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async insert(snapshot: {
    readonly businessId: string;
    readonly url: string;
    readonly runId: string;
    readonly contentHash: string;
    readonly intel: StoredSiteIntel & { readonly fetchedAt: string };
  }): Promise<WebsiteSnapshotRecord> {
    const { intel } = snapshot;
    const x = getExecutor(this.db);
    // A retried step does not store the same crawl twice.
    const [existing] = await x
      .select()
      .from(websiteSnapshots)
      .where(
        and(
          eq(websiteSnapshots.runId, snapshot.runId),
          eq(websiteSnapshots.contentHash, snapshot.contentHash),
        ),
      );
    if (existing) return toRecord(existing);
    const [row] = await x
      .insert(websiteSnapshots)
      .values({
        businessId: snapshot.businessId,
        url: snapshot.url,
        runId: snapshot.runId,
        contentHash: snapshot.contentHash,
        finalUrl: intel.finalUrl,
        fetchedAt: new Date(intel.fetchedAt),
        reachability: intel.reachability,
        httpStatus: intel.httpStatus,
        socialOnly: intel.socialOnly,
        tls: intel.tls,
        security: intel.security,
        languages: intel.languages,
        // Page markdown stays in object storage: keys only, never content.
        pages: intel.pages,
        contacts: intel.contacts,
        socials: intel.socials,
        booking: intel.booking,
        ordering: intel.ordering,
        chat: intel.chat,
        analytics: intel.analytics,
        tech: intel.tech,
        freshness: intel.freshness,
        mobile: intel.mobile,
        performanceHints: intel.performanceHints,
        links: intel.links,
        noSolicitation: intel.noSolicitation,
        logoCandidates: intel.logoCandidates,
        imageCandidates: intel.imageCandidates,
        warnings: intel.warnings,
        screenshotDesktopKey: intel.screenshots.desktopKey,
        screenshotMobileKey: intel.screenshots.mobileKey,
      })
      .returning();
    if (!row) throw new Error('website snapshot not inserted');
    await x.delete(websiteSnapshots).where(
      and(
        eq(websiteSnapshots.businessId, snapshot.businessId),
        sql`${websiteSnapshots.id} NOT IN (SELECT id FROM ${websiteSnapshots} k WHERE k.business_id = ${snapshot.businessId}
          ORDER BY k.fetched_at DESC LIMIT ${KEEP_SNAPSHOTS})`,
      ),
    );
    return toRecord(row);
  }

  async latest(businessId: string): Promise<WebsiteSnapshotRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(websiteSnapshots)
      .where(eq(websiteSnapshots.businessId, businessId))
      .orderBy(desc(websiteSnapshots.fetchedAt))
      .limit(1);
    return row ? toRecord(row) : undefined;
  }
}

/** The sticky no-solicitation marker (compliance): set by crawls, never cleared by one. */
@Injectable()
export class DrizzleNoSolicitationMarkers implements NoSolicitationMarkers {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async record(
    businessId: string,
    evidence: Parameters<NoSolicitationMarkers['record']>[1],
    at: Date,
  ): Promise<void> {
    const values = {
      pageUrl: evidence.pageUrl.slice(0, 2_000),
      phrases: [...evidence.phrases].slice(0, 20),
      snippet: evidence.snippet?.slice(0, 400) ?? null,
      snapshotId: evidence.snapshotId,
      lastDetectedAt: at,
    };
    await getExecutor(this.db)
      .insert(noSolicitationMarkers)
      .values({ businessId, firstDetectedAt: at, ...values })
      // Seen again: the latest evidence, and a cleared marker comes back.
      .onConflictDoUpdate({
        target: noSolicitationMarkers.businessId,
        set: { ...values, clearedAt: null, clearedBy: null },
      });
  }

  async active(businessId: string): Promise<boolean> {
    const marker = await this.find(businessId);
    return marker !== undefined && marker.clearedAt === null;
  }

  async find(businessId: string): Promise<NoSolicitationMarker | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(noSolicitationMarkers)
      .where(eq(noSolicitationMarkers.businessId, businessId));
    return row
      ? {
          firstDetectedAt: row.firstDetectedAt,
          lastDetectedAt: row.lastDetectedAt,
          pageUrl: row.pageUrl,
          phrases: row.phrases,
          snippet: row.snippet,
          clearedAt: row.clearedAt,
        }
      : undefined;
  }
}
