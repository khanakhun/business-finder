import type { FeatureVector } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { mlDatasets, mlTrainingRuns, scoringModels } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type {
  ContactRow,
  MlDatasetRecord,
  MlModelRecord,
  MlRepository,
  MlTrainingRunRecord,
  ModelRegistry,
} from '../../application/ml/ports.ts';
import { LABEL_DEFINITIONS } from '../../domain/ml/label-definition.ts';

// The dataset's source (BF-059): first contacts from the analytics facts (BF-058) — the first email for the offer
// or the first manual contact — with the outcomes that followed within the horizon, the score snapshot computed at
// or before the contact for a profile of that offer (`business_score_history`, never recomputed), and the preview
// built before it. Everything after `t0` other than the outcomes stays out by construction.

type RawRow = {
  business_id: string;
  t0: string;
  channel: string | null;
  locale: string | null;
  bounced: boolean;
  events: { at: string; kind: 'reply' | 'lead' | 'stage'; value: string | null }[];
  features: FeatureVector | null;
  snapshot_at: string | null;
  baseline_score: number | null;
  baseline_tier: string | null;
  preview_at: string | null;
  preview_quality: number | null;
};

@Injectable()
export class DrizzleMlRepository implements MlRepository, ModelRegistry {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async contacts(organizationId: string, offer: string, from: Date, to: Date, horizonDays: number) {
    const org = sql`${organizationId}::uuid`;
    const rows = await getExecutor(this.db).execute<RawRow>(sql`
      WITH firsts AS (
        SELECT DISTINCT ON (f.business_id) f.business_id, f.occurred_at AS t0, f.event_type, f.outcome, f.locale,
          f.message_id
        FROM analytics_facts f
        WHERE f.organization_id = ${org} AND f.business_id IS NOT NULL
          AND ((f.event_type = 'email_sent' AND f.offer = ${offer}) OR f.event_type = 'manual_contact')
        ORDER BY f.business_id, f.occurred_at)
      SELECT fi.business_id::text, fi.t0::text,
        CASE WHEN fi.event_type = 'email_sent' THEN 'email' ELSE fi.outcome END AS channel,
        fi.locale,
        EXISTS (SELECT 1 FROM analytics_facts b WHERE b.organization_id = ${org} AND b.event_type = 'email_bounced'
          AND b.outcome = 'hard' AND b.message_id = fi.message_id) AS bounced,
        (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'at', e.occurred_at,
            'kind', CASE e.event_type WHEN 'reply_triaged' THEN 'reply' WHEN 'lead_captured' THEN 'lead' ELSE 'stage' END,
            'value', e.outcome)), '[]'::jsonb)
          FROM analytics_facts e
          WHERE e.organization_id = ${org} AND e.business_id = fi.business_id
            AND e.event_type IN ('reply_triaged', 'lead_captured', 'pipeline_changed')
            AND e.occurred_at >= fi.t0 AND e.occurred_at <= fi.t0 + make_interval(days => ${horizonDays}::int)
        ) AS events,
        s.features, s.computed_at::text AS snapshot_at, s.score AS baseline_score, s.tier AS baseline_tier,
        (SELECT min(p.occurred_at)::text FROM analytics_facts p WHERE p.organization_id = ${org}
          AND p.business_id = fi.business_id AND p.event_type = 'preview_published' AND p.occurred_at < fi.t0
        ) AS preview_at,
        (SELECT g.quality_score FROM analytics_facts g WHERE g.organization_id = ${org}
          AND g.business_id = fi.business_id AND g.event_type = 'generation_finished'
          AND g.quality_score IS NOT NULL AND g.occurred_at < fi.t0
          ORDER BY g.occurred_at DESC LIMIT 1) AS preview_quality
      FROM firsts fi
      LEFT JOIN LATERAL (
        SELECT h.features, h.computed_at, h.score, h.tier
        FROM business_score_history h
        JOIN scoring_profile_versions v ON v.profile_id = h.profile_id AND v.version = h.profile_version
        WHERE h.organization_id = ${org} AND h.business_id = fi.business_id AND h.computed_at <= fi.t0
          AND coalesce(v.config ->> 'offer', '') = ${offer}
        ORDER BY h.computed_at DESC LIMIT 1) s ON true
      WHERE fi.t0 >= ${from.toISOString()}::timestamptz AND fi.t0 < ${to.toISOString()}::timestamptz
      ORDER BY fi.t0`);
    return rows.map(
      (row): ContactRow => ({
        businessId: row.business_id,
        t0: new Date(row.t0),
        channel: row.channel ?? 'email',
        locale: row.locale,
        bounced: row.bounced,
        events: row.events.map((event) => ({
          at: new Date(event.at),
          kind: event.kind,
          value: event.value ?? '',
        })),
        snapshot:
          row.features && row.snapshot_at
            ? {
                features: row.features,
                computedAt: new Date(row.snapshot_at),
                score: Number(row.baseline_score ?? 0),
                tier: row.baseline_tier ?? '',
              }
            : null,
        previewAt: row.preview_at ? new Date(row.preview_at) : null,
        previewQuality: row.preview_quality === null ? null : Number(row.preview_quality),
      }),
    );
  }

  async insertDataset(row: Omit<MlDatasetRecord, 'createdAt'>) {
    const [stored] = await getExecutor(this.db)
      .insert(mlDatasets)
      .values({
        id: row.id,
        organizationId: row.organizationId,
        offer: row.offer,
        labelVersion: row.labelVersion,
        windowFrom: row.from,
        windowTo: row.to,
        counts: row.counts,
        features: row.features,
        storageKey: row.storageKey,
        sha256: row.sha256,
        createdBy: row.createdBy,
      })
      .returning();
    if (!stored) throw new Error('dataset not stored');
    return { ...row, createdAt: stored.createdAt };
  }

  async datasets(organizationId: string, limit: number) {
    const rows = await getExecutor(this.db)
      .select()
      .from(mlDatasets)
      .where(eq(mlDatasets.organizationId, organizationId))
      .orderBy(desc(mlDatasets.createdAt))
      .limit(limit);
    return rows.map(datasetRecord);
  }

  async dataset(organizationId: string, id: string) {
    const [row] = await getExecutor(this.db)
      .select()
      .from(mlDatasets)
      .where(and(eq(mlDatasets.organizationId, organizationId), eq(mlDatasets.id, id)));
    return row ? datasetRecord(row) : undefined;
  }

  // ── Registry ──────────────────────────────────────────────────────────────────────────────────────────────

  async nextVersion(organizationId: string, offer: string) {
    const [row] = await getExecutor(this.db)
      .select({ max: sql<number | null>`max(${scoringModels.version})` })
      .from(scoringModels)
      .where(and(eq(scoringModels.organizationId, organizationId), eq(scoringModels.offer, offer)));
    return Number(row?.max ?? 0) + 1;
  }

  async insertModel(row: Parameters<ModelRegistry['insertModel']>[0]) {
    const [stored] = await getExecutor(this.db)
      .insert(scoringModels)
      .values({
        id: row.id,
        organizationId: row.organizationId,
        offer: row.offer,
        version: row.version,
        kind: row.kind,
        status: row.status,
        datasetId: row.datasetId,
        labelVersion: row.labelVersion,
        artifactKeys: row.artifactKeys,
        artifactHashes: row.artifactHashes,
        modelCard: row.modelCard,
        metrics: row.metrics,
        baselineMetrics: row.baselineMetrics,
        spearman: row.spearman,
        warnings: row.warnings,
        trainedBy: row.trainedBy,
      })
      .returning();
    if (!stored) throw new Error('model not stored');
    return modelRecord(stored);
  }

  async model(organizationId: string, id: string) {
    const [row] = await getExecutor(this.db)
      .select()
      .from(scoringModels)
      .where(and(eq(scoringModels.organizationId, organizationId), eq(scoringModels.id, id)));
    return row ? modelRecord(row) : undefined;
  }

  async models(organizationId: string) {
    const rows = await getExecutor(this.db)
      .select()
      .from(scoringModels)
      .where(eq(scoringModels.organizationId, organizationId))
      .orderBy(desc(scoringModels.trainedAt))
      .limit(100);
    return rows.map(modelRecord);
  }

  async monitored() {
    return getExecutor(this.db)
      .select({ organizationId: scoringModels.organizationId, id: scoringModels.id })
      .from(scoringModels)
      .where(inArray(scoringModels.status, ['active', 'shadow']));
  }

  async setStatus(
    organizationId: string,
    id: string,
    status: MlModelRecord['status'],
    promotion?: { by: string | null; at: Date },
  ) {
    await getExecutor(this.db)
      .update(scoringModels)
      .set({ status, ...(promotion ? { promotedBy: promotion.by, promotedAt: promotion.at } : {}) })
      .where(and(eq(scoringModels.organizationId, organizationId), eq(scoringModels.id, id)));
  }

  async insertRun(row: Parameters<ModelRegistry['insertRun']>[0]) {
    await getExecutor(this.db).insert(mlTrainingRuns).values(row);
  }

  async run(id: string) {
    const [row] = await getExecutor(this.db).select().from(mlTrainingRuns).where(eq(mlTrainingRuns.id, id));
    return row ? runRecord(row) : undefined;
  }

  async updateRun(id: string, patch: Parameters<ModelRegistry['updateRun']>[1]) {
    await getExecutor(this.db).update(mlTrainingRuns).set(patch).where(eq(mlTrainingRuns.id, id));
  }

  async runs(organizationId: string, limit: number) {
    const rows = await getExecutor(this.db)
      .select({ run: mlTrainingRuns, offer: mlDatasets.offer })
      .from(mlTrainingRuns)
      .innerJoin(mlDatasets, eq(mlDatasets.id, mlTrainingRuns.datasetId))
      .where(eq(mlTrainingRuns.organizationId, organizationId))
      .orderBy(desc(mlTrainingRuns.createdAt))
      .limit(limit);
    return rows.map((row) => ({ ...runRecord(row.run), offer: row.offer }));
  }
}

const runRecord = (row: typeof mlTrainingRuns.$inferSelect): MlTrainingRunRecord => ({
  id: row.id,
  organizationId: row.organizationId,
  datasetId: row.datasetId,
  status: row.status,
  considerGbm: row.considerGbm,
  error: row.error,
  modelId: row.modelId,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  finishedAt: row.finishedAt,
});

const modelRecord = (row: typeof scoringModels.$inferSelect): MlModelRecord => ({
  id: row.id,
  organizationId: row.organizationId,
  offer: row.offer as MlModelRecord['offer'],
  version: row.version,
  kind: row.kind,
  status: row.status,
  datasetId: row.datasetId,
  labelVersion: row.labelVersion,
  artifactKeys: row.artifactKeys,
  artifactHashes: row.artifactHashes,
  modelCard: row.modelCard,
  metrics: row.metrics,
  baselineMetrics: row.baselineMetrics,
  spearman: row.spearman,
  warnings: row.warnings,
  trainedBy: row.trainedBy,
  trainedAt: row.trainedAt,
  promotedBy: row.promotedBy,
  promotedAt: row.promotedAt,
});

const datasetRecord = (row: typeof mlDatasets.$inferSelect): MlDatasetRecord => ({
  id: row.id,
  organizationId: row.organizationId,
  offer: row.offer as MlDatasetRecord['offer'],
  labelVersion: row.labelVersion,
  horizonDays: LABEL_DEFINITIONS[row.labelVersion]?.horizonDays ?? 0,
  from: row.windowFrom,
  to: row.windowTo,
  counts: row.counts,
  features: row.features,
  sha256: row.sha256,
  storageKey: row.storageKey,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
});
