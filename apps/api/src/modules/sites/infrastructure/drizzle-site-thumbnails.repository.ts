import { type DbClient, getExecutor } from '@bf/db';
import { sitePublications, sites } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { SiteThumbnailsRepository, StoredThumbnails } from '../application/ports.ts';

@Injectable()
export class DrizzleSiteThumbnailsRepository implements SiteThumbnailsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async publication(siteId: string, publicationId: string) {
    const [row] = await getExecutor(this.db)
      .select({
        organizationId: sites.organizationId,
        hostname: sitePublications.hostname,
        status: sitePublications.status,
      })
      .from(sitePublications)
      .innerJoin(sites, eq(sites.id, sitePublications.siteId))
      .where(and(eq(sitePublications.id, publicationId), eq(sitePublications.siteId, siteId)))
      .limit(1);
    return row;
  }

  async get(siteId: string): Promise<StoredThumbnails | null> {
    const [row] = await getExecutor(this.db)
      .select({ thumbnails: sites.thumbnails })
      .from(sites)
      .where(eq(sites.id, siteId))
      .limit(1);
    return row?.thumbnails ?? null;
  }

  async setIfActive(siteId: string, thumbnails: StoredThumbnails): Promise<boolean> {
    const rows = await getExecutor(this.db)
      .update(sites)
      .set({ thumbnails: { ...thumbnails } })
      .where(
        and(
          eq(sites.id, siteId),
          sql`EXISTS (SELECT 1 FROM ${sitePublications} WHERE ${sitePublications.id} = ${thumbnails.publicationId}
                AND ${sitePublications.siteId} = ${siteId} AND ${sitePublications.status} = 'active')`,
        ),
      )
      .returning({ id: sites.id });
    return rows.length > 0;
  }
}
