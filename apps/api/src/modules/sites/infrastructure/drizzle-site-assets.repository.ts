import { type DbClient, getExecutor } from '@bf/db';
import { siteAssets, siteVersions } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { SiteAssetsRepository, StoredAsset } from '../application/ports.ts';

const columns = {
  id: siteAssets.id,
  organizationId: siteAssets.organizationId,
  siteId: siteAssets.siteId,
  storageKey: siteAssets.storageKey,
  status: siteAssets.status,
  mime: siteAssets.mime,
  width: siteAssets.width,
  height: siteAssets.height,
  bytes: siteAssets.bytes,
  publicUrl: siteAssets.publicUrl,
  variants: siteAssets.variants,
  license: siteAssets.license,
  licenseDetails: siteAssets.licenseDetails,
  alt: siteAssets.alt,
  dominantColors: siteAssets.dominantColors,
  createdAt: siteAssets.createdAt,
};

@Injectable()
export class DrizzleSiteAssetsRepository implements SiteAssetsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async insert(asset: Parameters<SiteAssetsRepository['insert']>[0]): Promise<StoredAsset> {
    const [row] = await getExecutor(this.db).insert(siteAssets).values(asset).returning(columns);
    if (!row) throw new Error('site asset insert returned no row');
    return row;
  }

  async get(organizationId: string, siteId: string, assetId: string) {
    const [row] = await getExecutor(this.db)
      .select(columns)
      .from(siteAssets)
      .where(
        and(
          eq(siteAssets.id, assetId),
          eq(siteAssets.organizationId, organizationId),
          eq(siteAssets.siteId, siteId),
        ),
      )
      .limit(1);
    return row;
  }

  async byId(assetId: string) {
    const [row] = await getExecutor(this.db)
      .select(columns)
      .from(siteAssets)
      .where(eq(siteAssets.id, assetId))
      .limit(1);
    return row;
  }

  async list(organizationId: string, siteId: string) {
    return getExecutor(this.db)
      .select(columns)
      .from(siteAssets)
      .where(and(eq(siteAssets.organizationId, organizationId), eq(siteAssets.siteId, siteId)))
      .orderBy(desc(siteAssets.createdAt), desc(siteAssets.id))
      .limit(500);
  }

  async update(assetId: string, changes: Parameters<SiteAssetsRepository['update']>[1]): Promise<void> {
    await getExecutor(this.db).update(siteAssets).set(changes).where(eq(siteAssets.id, assetId));
  }

  /** A text search of the versions' specs (an image is named by its id or one of its URLs). */
  async referenced(siteId: string, needles: readonly string[]): Promise<boolean> {
    if (needles.length === 0) return false;
    const [row] = await getExecutor(this.db)
      .select({ id: siteVersions.id })
      .from(siteVersions)
      .where(
        and(
          eq(siteVersions.siteId, siteId),
          or(...needles.map((needle) => sql`strpos(${siteVersions.spec}::text, ${needle}) > 0`)),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async delete(assetId: string): Promise<void> {
    await getExecutor(this.db).delete(siteAssets).where(eq(siteAssets.id, assetId));
  }
}
