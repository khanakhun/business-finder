import { type DbClient, getExecutor } from '@bf/db';
import { siteExports } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { ExportRecord, ExportRepository } from '../application/go-live/export.service.ts';

const columns = {
  id: siteExports.id,
  organizationId: siteExports.organizationId,
  siteId: siteExports.siteId,
  versionId: siteExports.versionId,
  status: siteExports.status,
  objectKey: siteExports.objectKey,
  bytes: siteExports.bytes,
  error: siteExports.error,
  createdAt: siteExports.createdAt,
  finishedAt: siteExports.finishedAt,
};

/** Static exports of sites (BF-062). */
@Injectable()
export class DrizzleExportRepository implements ExportRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async insert(record: {
    id: string;
    organizationId: string;
    siteId: string;
    versionId: string;
    requestedBy: string | null;
  }): Promise<void> {
    await getExecutor(this.db).insert(siteExports).values(record);
  }

  async list(organizationId: string, siteId: string, limit: number): Promise<ExportRecord[]> {
    return getExecutor(this.db)
      .select(columns)
      .from(siteExports)
      .where(and(eq(siteExports.organizationId, organizationId), eq(siteExports.siteId, siteId)))
      .orderBy(desc(siteExports.createdAt))
      .limit(limit);
  }

  async claim(id: string): Promise<ExportRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .update(siteExports)
      .set({ status: 'running' })
      .where(and(eq(siteExports.id, id), eq(siteExports.status, 'queued')))
      .returning(columns);
    return row;
  }

  async finish(
    id: string,
    result: { status: 'succeeded' | 'failed'; objectKey?: string; bytes?: number; error?: string; at: Date },
  ): Promise<void> {
    await getExecutor(this.db)
      .update(siteExports)
      .set({
        status: result.status,
        objectKey: result.objectKey ?? null,
        bytes: result.bytes ?? null,
        error: result.error ?? null,
        finishedAt: result.at,
      })
      .where(eq(siteExports.id, id));
  }
}
