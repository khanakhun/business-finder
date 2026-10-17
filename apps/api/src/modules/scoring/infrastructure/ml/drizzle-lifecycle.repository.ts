import type { FeatureVector, ModelMonitoring } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { scoringModelMonitoring, scoringModelPromotions } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type {
  ModelLifecycleRepository,
  PromotionRecord,
  ScoresAtContact,
} from '../../application/ml/ports.ts';

// Promotions, monitoring and their reads (BF-059): what the active profile and the shadow model said about each
// contact at its time, recent feature vectors, and the shadow's current probabilities.

const list = (values: readonly string[], type: 'uuid' | 'timestamptz') =>
  sql.join(
    values.map((value) => sql`${value}::${sql.raw(type)}`),
    sql`, `,
  );

@Injectable()
export class DrizzleLifecycleRepository implements ModelLifecycleRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async scoresAt(
    organizationId: string,
    profileId: string,
    modelId: string,
    contacts: readonly { businessId: string; t0: Date }[],
  ): Promise<ScoresAtContact[]> {
    if (contacts.length === 0) return [];
    const rows = await getExecutor(this.db).execute<{
      business_id: string;
      active_score: number | null;
      active_tier: string | null;
      shadow_probability: number | null;
      shadow_tier: string | null;
    }>(sql`
      SELECT u.business_id::text,
        a.score AS active_score, a.tier AS active_tier,
        s.probability AS shadow_probability, s.tier AS shadow_tier
      FROM unnest(ARRAY[${list(
        contacts.map((c) => c.businessId),
        'uuid',
      )}],
                  ARRAY[${list(
                    contacts.map((c) => c.t0.toISOString()),
                    'timestamptz',
                  )}]) AS u(business_id, t0)
      LEFT JOIN LATERAL (
        SELECT h.score, h.tier FROM business_score_history h
        WHERE h.organization_id = ${organizationId}::uuid AND h.business_id = u.business_id
          AND h.profile_id = ${profileId}::uuid AND h.computed_at <= u.t0
        ORDER BY h.computed_at DESC LIMIT 1) a ON true
      LEFT JOIN LATERAL (
        SELECT x.probability, x.tier FROM business_score_shadows x
        WHERE x.organization_id = ${organizationId}::uuid AND x.business_id = u.business_id
          AND x.profile_id = ${profileId}::uuid AND x.model_id = ${modelId}::uuid AND x.computed_at <= u.t0
        ORDER BY x.computed_at DESC LIMIT 1) s ON true`);
    return rows.map((row) => ({
      businessId: row.business_id,
      activeScore: row.active_score === null ? null : Number(row.active_score),
      activeTier: row.active_tier,
      shadowProbability: row.shadow_probability === null ? null : Number(row.shadow_probability),
      shadowTier: row.shadow_tier,
    }));
  }

  async shadowProbabilities(organizationId: string, modelId: string) {
    const rows = await getExecutor(this.db).execute<{ p: number }>(sql`
      SELECT DISTINCT ON (business_id) probability AS p FROM business_score_shadows
      WHERE organization_id = ${organizationId}::uuid AND model_id = ${modelId}::uuid
      ORDER BY business_id, computed_at DESC`);
    return rows.map((row) => Number(row.p));
  }

  async recentVectors(organizationId: string, offer: string, since: Date) {
    const rows = await getExecutor(this.db).execute<{ features: FeatureVector }>(sql`
      SELECT DISTINCT ON (h.business_id) h.features
      FROM business_score_history h
      JOIN scoring_profile_versions v ON v.profile_id = h.profile_id AND v.version = h.profile_version
      WHERE h.organization_id = ${organizationId}::uuid AND h.computed_at >= ${since.toISOString()}::timestamptz
        AND coalesce(v.config ->> 'offer', '') = ${offer}
      ORDER BY h.business_id, h.computed_at DESC`);
    return rows.map((row) => row.features);
  }

  async insertPromotion(row: Omit<PromotionRecord, 'promotedAt' | 'rolledBackAt'>) {
    await getExecutor(this.db).insert(scoringModelPromotions).values({
      id: row.id,
      organizationId: row.organizationId,
      profileId: row.profileId,
      modelId: row.modelId,
      fromVersion: row.fromVersion,
      toVersion: row.toVersion,
      eligible: row.eligible,
      overrideReason: row.overrideReason,
      comparison: row.comparison,
      promotedBy: row.promotedBy,
    });
  }

  async latestPromotion(organizationId: string, profileId: string) {
    const [row] = await getExecutor(this.db)
      .select()
      .from(scoringModelPromotions)
      .where(
        and(
          eq(scoringModelPromotions.organizationId, organizationId),
          eq(scoringModelPromotions.profileId, profileId),
          isNull(scoringModelPromotions.rolledBackAt),
        ),
      )
      .orderBy(desc(scoringModelPromotions.promotedAt))
      .limit(1);
    return row ? promotion(row) : undefined;
  }

  async promotions(organizationId: string) {
    const rows = await getExecutor(this.db)
      .select()
      .from(scoringModelPromotions)
      .where(eq(scoringModelPromotions.organizationId, organizationId))
      .orderBy(desc(scoringModelPromotions.promotedAt))
      .limit(50);
    return rows.map(promotion);
  }

  async markRolledBack(id: string, by: string | null, at: Date) {
    await getExecutor(this.db)
      .update(scoringModelPromotions)
      .set({ rolledBackAt: at, rolledBackBy: by })
      .where(eq(scoringModelPromotions.id, id));
  }

  async insertMonitoring(organizationId: string, row: Omit<ModelMonitoring, 'at'>) {
    await getExecutor(this.db)
      .insert(scoringModelMonitoring)
      .values({ organizationId, ...row });
  }

  async latestMonitoring(organizationId: string, modelId: string) {
    const [row] = await getExecutor(this.db)
      .select()
      .from(scoringModelMonitoring)
      .where(
        and(
          eq(scoringModelMonitoring.organizationId, organizationId),
          eq(scoringModelMonitoring.modelId, modelId),
        ),
      )
      .orderBy(desc(scoringModelMonitoring.at))
      .limit(1);
    return row
      ? {
          modelId: row.modelId,
          at: row.at.toISOString(),
          featurePsi: row.featurePsi,
          scorePsi: row.scorePsi,
          auc: row.auc,
          validationAuc: row.validationAuc,
          recentContacts: row.recentContacts,
          alerts: row.alerts,
        }
      : undefined;
  }
}

const promotion = (row: typeof scoringModelPromotions.$inferSelect): PromotionRecord => ({
  id: row.id,
  organizationId: row.organizationId,
  profileId: row.profileId,
  modelId: row.modelId,
  fromVersion: row.fromVersion,
  toVersion: row.toVersion,
  eligible: row.eligible,
  overrideReason: row.overrideReason,
  comparison: row.comparison,
  promotedBy: row.promotedBy,
  promotedAt: row.promotedAt,
  rolledBackAt: row.rolledBackAt,
});
