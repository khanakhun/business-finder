import type { GenerationWorkspaceSettings } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { generationWorkspaceSettings } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { GenerationSettingsStore } from '../application/ports.ts';

/** A workspace's generation settings, one row per workspace (BF-046). */
@Injectable()
export class DrizzleGenerationSettingsStore implements GenerationSettingsStore {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async get(organizationId: string) {
    const [row] = await this.x
      .select({
        settings: generationWorkspaceSettings.settings,
        updatedAt: generationWorkspaceSettings.updatedAt,
      })
      .from(generationWorkspaceSettings)
      .where(eq(generationWorkspaceSettings.organizationId, organizationId))
      .limit(1);
    return row;
  }

  async put(organizationId: string, userId: string, settings: GenerationWorkspaceSettings): Promise<Date> {
    const now = new Date();
    await this.x
      .insert(generationWorkspaceSettings)
      .values({ organizationId, settings, updatedBy: userId, updatedAt: now })
      .onConflictDoUpdate({
        target: generationWorkspaceSettings.organizationId,
        set: { settings, updatedBy: userId, updatedAt: now },
      });
    return now;
  }
}
