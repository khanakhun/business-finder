import { gunzipSync } from 'node:zlib';
import {
  AUC_DROP_ALERT,
  type Clock,
  FEATURE_KEYS,
  type FeatureVector,
  type ModelMonitoring,
  NotFoundError,
  PSI_ALERT_THRESHOLD,
} from '@bf/contracts';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit, Optional } from '@nestjs/common';
import { MemberDirectory } from '../../../identity/index.ts';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { LOGGER, type Logger } from '../../../platform/logging/logger.ts';
import type { ObjectStorage } from '../../../platform/storage/object-storage.ts';
import { NotificationService } from '../../../realtime/index.ts';
import { histogram, psi, quantileEdges } from '../../domain/ml/drift.ts';
import { CURRENT_LABEL_VERSION, LABEL_DEFINITIONS, labelOf } from '../../domain/ml/label-definition.ts';
import { calibrate, inputRow } from '../../domain/ml/preprocessing.ts';
import { rocAuc } from '../../domain/ml/stats.ts';
import { decisionContext } from './model-scoring.ts';
import {
  ML_REPOSITORY,
  ML_STORAGE,
  type MlModelRecord,
  type MlRepository,
  MODEL_LIFECYCLE,
  MODEL_REGISTRY,
  MODEL_RUNTIME,
  type ModelLifecycleRepository,
  type ModelRegistry,
  type ModelRuntime,
  SHADOW_REPOSITORY,
  type ShadowRepository,
} from './ports.ts';

// Drift and decay (BF-059): monthly for every active or shadow model, and on demand. Feature drift is the PSI of
// each score feature, training vs the last 30 days of feature vectors; score drift the PSI of the model's
// probabilities on both; decay the ROC-AUC on contacts labelled since training, against the validation AUC. A PSI
// over 0.25 on one of the model's top features, or an AUC down by more than 0.05, notifies the owners. Retraining
// is recommended, never started (and nothing is promoted) on its own.

const DAY = 86_400_000;
const EVERY_MS = 6 * 60 * 60_000;
const MONTH = 30 * DAY;
const TOP_FEATURES = 5;
const MIN_DECAY_CONTACTS = 30;
const MIN_RECENT = 30;

type Row = { readonly features: Record<string, unknown> };

const counts = (values: readonly unknown[], categories: readonly string[]) =>
  categories.map((category) => values.filter((value) => String(value ?? '∅') === category).length);

@Injectable()
export class ModelMonitor implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(MODEL_REGISTRY) private readonly registry: ModelRegistry,
    @Inject(ML_REPOSITORY) private readonly datasets: MlRepository,
    @Inject(MODEL_LIFECYCLE) private readonly lifecycle: ModelLifecycleRepository,
    @Inject(SHADOW_REPOSITORY) private readonly shadows: ShadowRepository,
    @Inject(MODEL_RUNTIME) private readonly runtime: ModelRuntime,
    @Inject(ML_STORAGE) private readonly storage: ObjectStorage,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly members: MemberDirectory,
    private readonly notifications: NotificationService,
    @Optional() @Inject('ML_MONITOR_AUTOSTART') private readonly autostart?: boolean,
  ) {}

  onModuleInit() {
    if (!this.autostart) return;
    this.timer = setInterval(
      () =>
        void this.sweep().catch((err: unknown) => this.logger.warn({ err }, 'model monitoring sweep failed')),
      EVERY_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  latest(organizationId: string, modelId: string) {
    return this.lifecycle.latestMonitoring(organizationId, modelId);
  }

  /** Every active or shadow model whose last check is a month old (worker). */
  async sweep(): Promise<number> {
    let ran = 0;
    for (const { organizationId, id } of await this.registry.monitored()) {
      const last = await this.lifecycle.latestMonitoring(organizationId, id);
      if (last && this.clock.now().getTime() - Date.parse(last.at) < MONTH) continue;
      await this.run(organizationId, id).catch((err: unknown) =>
        this.logger.warn({ err, modelId: id }, 'model monitoring failed'),
      );
      ran++;
    }
    return ran;
  }

  async run(organizationId: string, modelId: string): Promise<ModelMonitoring> {
    const model = await this.registry.model(organizationId, modelId);
    if (!model) throw new NotFoundError('ScoringModel', modelId);
    const now = this.clock.now();
    const training = await this.trainingRows(model);
    const recent: Row[] = (
      await this.lifecycle.recentVectors(organizationId, model.offer, new Date(now.getTime() - MONTH))
    ).map((features) => ({ features: { ...features, ...decisionContext(model.offer) } }));
    const spec = await this.runtime.spec(model);

    // Feature drift (score features only: the context features are fixed for live scores).
    const keys = new Set<string>(FEATURE_KEYS);
    // Too few recent vectors say nothing about drift (PSI of an empty side reads 0): none is reported.
    const featurePsi = (recent.length >= MIN_RECENT ? spec.columns : [])
      .map((column) => column.source)
      .filter((source, i, all) => keys.has(source) && all.indexOf(source) === i)
      .map((feature) => ({ feature, psi: this.featurePsi(feature, training, recent) }));
    const weight = new Map<string, number>();
    for (const [j, column] of spec.columns.entries())
      weight.set(
        column.source,
        (weight.get(column.source) ?? 0) + Math.abs(spec.linear?.coefficients[j] ?? 0),
      );
    const top = new Set(
      [...featurePsi]
        .sort((a, b) =>
          spec.linear ? (weight.get(b.feature) ?? 0) - (weight.get(a.feature) ?? 0) : b.psi - a.psi,
        )
        .slice(0, TOP_FEATURES)
        .map((item) => item.feature),
    );

    // Score drift.
    const probabilities = async (rows: Row[]) =>
      (
        await this.runtime.predict(
          model,
          rows.map((row) => inputRow(spec, row.features as FeatureVector)),
        )
      ).map((raw) => calibrate(spec.calibration, raw));
    const trainScores = await probabilities(training);
    const recentScores = await probabilities(recent);
    const edges = quantileEdges(trainScores);
    const scorePsi =
      trainScores.length > 0 && recentScores.length >= MIN_RECENT
        ? psi(histogram(trainScores, edges), histogram(recentScores, edges))
        : null;

    // Decay: contacts since training, scored as the model saw them at the contact.
    const decay = await this.decay(organizationId, model, now);
    const validationAuc = model.metrics.rocAuc;
    const alerts: string[] = [];
    for (const item of featurePsi)
      if (top.has(item.feature) && item.psi > PSI_ALERT_THRESHOLD)
        alerts.push(`${item.feature} shifted (PSI ${item.psi.toFixed(2)}).`);
    if (decay.auc !== null && validationAuc !== null && validationAuc - decay.auc > AUC_DROP_ALERT)
      alerts.push(`ROC-AUC fell from ${validationAuc.toFixed(2)} to ${decay.auc.toFixed(2)}.`);
    const result: Omit<ModelMonitoring, 'at'> = {
      modelId: model.id,
      featurePsi: featurePsi
        .map((item) => ({ ...item, psi: Math.round(item.psi * 10_000) / 10_000, top: top.has(item.feature) }))
        .sort((a, b) => b.psi - a.psi),
      scorePsi: scorePsi === null ? null : Math.round(scorePsi * 10_000) / 10_000,
      auc: decay.auc,
      validationAuc,
      recentContacts: decay.contacts,
      alerts,
    };
    await this.lifecycle.insertMonitoring(organizationId, result);
    if (alerts.length > 0) {
      const recipients = await this.members.ownerIds(organizationId);
      if (recipients.length > 0)
        await this.notifications.notify({
          organizationId,
          recipients,
          type: 'scoring_drift',
          params: { model: `v${model.version} (${model.offer})`, summary: alerts.join(' ').slice(0, 200) },
          entity: { type: 'scoring_model', id: model.id },
          link: '/settings/scoring',
        });
    }
    return { ...result, at: now.toISOString() };
  }

  private async trainingRows(model: MlModelRecord): Promise<Row[]> {
    const dataset = await this.datasets.dataset(model.organizationId, model.datasetId);
    if (!dataset) return [];
    const stored = await this.storage.get(dataset.storageKey);
    if (!stored) return [];
    return gunzipSync(stored.body)
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Row);
  }

  private featurePsi(feature: string, training: Row[], recent: Row[]): number {
    const before = training.map((row) => row.features[feature]);
    const after = recent.map((row) => row.features[feature]);
    const numbers = (values: unknown[]) =>
      values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const trainNumbers = numbers(before);
    if (trainNumbers.length > 0 && trainNumbers.length >= before.filter((v) => v !== null).length * 0.9) {
      const edges = quantileEdges(trainNumbers);
      // Missing values are their own bin.
      return psi(
        [...histogram(trainNumbers, edges), before.filter((v) => v === null || v === undefined).length],
        [...histogram(numbers(after), edges), after.filter((v) => v === null || v === undefined).length],
      );
    }
    const categories = [...new Set([...before, ...after].map((value) => String(value ?? '∅')))];
    return psi(counts(before, categories), counts(after, categories));
  }

  private async decay(organizationId: string, model: MlModelRecord, now: Date) {
    const none = { auc: null, contacts: 0 };
    const definition = LABEL_DEFINITIONS[CURRENT_LABEL_VERSION];
    if (!definition) return none;
    const profileId =
      [...(await this.shadows.assignments(organizationId)).entries()].find(
        ([, row]) => row.modelId === model.id,
      )?.[0] ??
      (await this.lifecycle.promotions(organizationId)).find((p) => p.modelId === model.id && !p.rolledBackAt)
        ?.profileId;
    if (!profileId) return none;
    const contacts = (
      await this.datasets.contacts(organizationId, model.offer, model.trainedAt, now, definition.horizonDays)
    )
      .map((row) => ({
        row,
        label: labelOf({ firstContactAt: row.t0, bounced: row.bounced, events: row.events }, definition, now),
      }))
      .filter((item) => item.label === 'positive' || item.label === 'negative');
    const scores = await this.lifecycle.scoresAt(
      organizationId,
      profileId,
      model.id,
      contacts.map(({ row }) => ({ businessId: row.businessId, t0: row.t0 })),
    );
    const pairs = contacts.flatMap((item, i) => {
      const score = scores[i];
      const value =
        model.status === 'active'
          ? score?.activeScore === null || score?.activeScore === undefined
            ? null
            : score.activeScore / 100
          : (score?.shadowProbability ?? null);
      return value === null
        ? []
        : [{ value, label: item.label === 'positive' ? (1 as const) : (0 as const) }];
    });
    if (pairs.length < MIN_DECAY_CONTACTS) return { auc: null, contacts: pairs.length };
    return {
      auc: rocAuc(
        pairs.map((pair) => pair.value),
        pairs.map((pair) => pair.label),
      ),
      contacts: pairs.length,
    };
  }
}
