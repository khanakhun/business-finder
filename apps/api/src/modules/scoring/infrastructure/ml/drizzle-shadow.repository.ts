import { type DbClient, getExecutor } from '@bf/db';
import { businessScoreShadows, scoringShadowAssignments } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type { ShadowRepository, ShadowScoreRow } from '../../application/ml/ports.ts';

/** Shadow assignments and append-only shadow scores (BF-059). */
@Injectable()
export class DrizzleShadowRepository implements ShadowRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async assignments(organizationId: string) {
    const rows = await getExecutor(this.db)
      .select()
      .from(scoringShadowAssignments)
      .where(eq(scoringShadowAssignments.organizationId, organizationId));
    return new Map(rows.map((row) => [row.profileId, { modelId: row.modelId, startedAt: row.startedAt }]));
  }

  async assign(organizationId: string, profileId: string, modelId: string, userId: string | null) {
    await getExecutor(this.db)
      .insert(scoringShadowAssignments)
      .values({ organizationId, profileId, modelId, startedBy: userId })
      .onConflictDoUpdate({
        target: [scoringShadowAssignments.organizationId, scoringShadowAssignments.profileId],
        set: { modelId, startedBy: userId, startedAt: sql`now()` },
      });
  }

  async unassign(organizationId: string, profileId: string) {
    const [row] = await getExecutor(this.db)
      .delete(scoringShadowAssignments)
      .where(
        and(
          eq(scoringShadowAssignments.organizationId, organizationId),
          eq(scoringShadowAssignments.profileId, profileId),
        ),
      )
      .returning({ modelId: scoringShadowAssignments.modelId });
    return row?.modelId ?? null;
  }

  async latestHashes(organizationId: string, profileId: string, businessIds: readonly string[]) {
    if (businessIds.length === 0) return new Map<string, { factsHash: string; modelId: string }>();
    const rows = await getExecutor(this.db)
      .selectDistinctOn([businessScoreShadows.businessId], {
        businessId: businessScoreShadows.businessId,
        factsHash: businessScoreShadows.factsHash,
        modelId: businessScoreShadows.modelId,
      })
      .from(businessScoreShadows)
      .where(
        and(
          eq(businessScoreShadows.organizationId, organizationId),
          eq(businessScoreShadows.profileId, profileId),
          inArray(businessScoreShadows.businessId, [...businessIds]),
        ),
      )
      .orderBy(businessScoreShadows.businessId, desc(businessScoreShadows.computedAt));
    return new Map(rows.map((row) => [row.businessId, { factsHash: row.factsHash, modelId: row.modelId }]));
  }

  async insert(rows: readonly ShadowScoreRow[]) {
    if (rows.length === 0) return;
    await getExecutor(this.db)
      .insert(businessScoreShadows)
      .values([...rows]);
  }

  async latest(organizationId: string, businessId: string): Promise<ShadowScoreRow[]> {
    const rows = await getExecutor(this.db)
      .selectDistinctOn([businessScoreShadows.profileId])
      .from(businessScoreShadows)
      .where(
        and(
          eq(businessScoreShadows.organizationId, organizationId),
          eq(businessScoreShadows.businessId, businessId),
        ),
      )
      .orderBy(businessScoreShadows.profileId, desc(businessScoreShadows.computedAt));
    return rows.map((row) => ({ ...row, tier: row.tier }));
  }
}
