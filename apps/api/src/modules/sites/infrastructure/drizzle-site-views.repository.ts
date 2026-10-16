import { type DbClient, getExecutor } from '@bf/db';
import { sites, siteViewDaily } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { DayViews, SiteViewsRepository } from '../application/ports.ts';

@Injectable()
export class DrizzleSiteViewsRepository implements SiteViewsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async upsertDays(views: readonly DayViews[]): Promise<number> {
    if (views.length === 0) return 0;
    const executor = getExecutor(this.db);
    // A deleted site's views are dropped (its counters expire in Valkey).
    const existing = new Set(
      (
        await executor
          .select({ id: sites.id })
          .from(sites)
          .where(inArray(sites.id, [...new Set(views.map((view) => view.siteId))]))
      ).map((row) => row.id),
    );
    const rows = views
      .filter((view) => existing.has(view.siteId))
      .map((view) => ({
        siteId: view.siteId,
        day: view.day,
        pageViews: view.pageViews,
        uniqueEstimate: Math.min(view.uniqueEstimate, view.pageViews),
        byLocale: view.byLocale,
        byCampaign: view.byCampaign,
      }));
    if (rows.length === 0) return 0;
    // Totals are absolute (recounted from Valkey): a later flush of the same day replaces them.
    await executor
      .insert(siteViewDaily)
      .values(rows)
      .onConflictDoUpdate({
        target: [siteViewDaily.siteId, siteViewDaily.day],
        set: {
          pageViews: sql`excluded.page_views`,
          uniqueEstimate: sql`excluded.unique_estimate`,
          byLocale: sql`excluded.by_locale`,
          byCampaign: sql`excluded.by_campaign`,
        },
      });
    return rows.length;
  }

  async totals(siteId: string, fromDay: string) {
    const [row] = await getExecutor(this.db)
      .select({
        pageViews: sql<number>`coalesce(sum(${siteViewDaily.pageViews}), 0)::int`,
        uniqueEstimate: sql<number>`coalesce(sum(${siteViewDaily.uniqueEstimate}), 0)::int`,
      })
      .from(siteViewDaily)
      .where(and(eq(siteViewDaily.siteId, siteId), gte(siteViewDaily.day, fromDay)));
    return row ?? { pageViews: 0, uniqueEstimate: 0 };
  }

  async refs(siteIds: readonly string[]) {
    if (siteIds.length === 0) return [];
    return getExecutor(this.db)
      .select({ id: sites.id, organizationId: sites.organizationId, businessId: sites.businessId })
      .from(sites)
      .where(inArray(sites.id, [...siteIds]));
  }
}
