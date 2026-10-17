import type { ApiEnv } from '@bf/config';
import {
  type Clock,
  type MlModel,
  type MlTrainingRun,
  NotFoundError,
  newId,
  type StartMlTrainingRequest,
  StartMlTrainingRequestSchema,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv } from '../../../platform/config/app-env.ts';
import { LOGGER, type Logger } from '../../../platform/logging/logger.ts';
import { OBJECT_PRESIGNER, type ObjectPresigner } from '../../../platform/storage/s3-presigner.ts';
import type { MlActor } from './dataset-builder.ts';
import {
  type ArtifactName,
  ML_REPOSITORY,
  type MlModelRecord,
  type MlRepository,
  MODEL_REGISTRY,
  MODEL_TRAINER_PORT,
  type ModelRegistry,
  type ModelTrainerPort,
  TRAINING_QUEUE,
  type TrainingQueue,
} from './ports.ts';

// Training runs (BF-059, Pipeline: dataset → train → evaluate → export → register). A run is queued by an owner or
// admin and executed by the worker: intel gets a presigned GET of the dataset and presigned PUTs for the artifacts,
// trains (no database access, no storage credentials), and answers with metrics and hashes; the API registers an
// immutable model version (`trained`). A failure ends the run with its message; nothing is retried on its own.

const URL_TTL_SECONDS = 30 * 60;

const CONTENT_TYPES: Record<ArtifactName, string> = {
  model: 'application/octet-stream',
  preprocessing: 'application/json',
  modelCardJson: 'application/json',
  modelCardMd: 'text/markdown; charset=utf-8',
};

const FILES: Record<ArtifactName, string> = {
  model: 'model.onnx',
  preprocessing: 'preprocessing.json',
  modelCardJson: 'model-card.json',
  modelCardMd: 'model-card.md',
};

export const toModelView = (record: MlModelRecord): MlModel => ({
  id: record.id,
  offer: record.offer,
  version: record.version,
  kind: record.kind,
  status: record.status,
  datasetId: record.datasetId,
  labelVersion: record.labelVersion,
  metrics: record.metrics,
  baselineMetrics: record.baselineMetrics,
  spearman: record.spearman,
  modelCard: record.modelCard,
  warnings: record.warnings,
  trainedBy: record.trainedBy,
  trainedAt: record.trainedAt.toISOString(),
  promotedBy: record.promotedBy,
  promotedAt: record.promotedAt?.toISOString() ?? null,
});

@Injectable()
export class ModelTrainer {
  constructor(
    @Inject(ML_REPOSITORY) private readonly datasets: MlRepository,
    @Inject(MODEL_REGISTRY) private readonly registry: ModelRegistry,
    @Inject(MODEL_TRAINER_PORT) private readonly intel: ModelTrainerPort,
    @Inject(TRAINING_QUEUE) private readonly queue: TrainingQueue,
    @Inject(OBJECT_PRESIGNER) private readonly presigner: ObjectPresigner,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async start(actor: MlActor, input: StartMlTrainingRequest): Promise<MlTrainingRun> {
    const request = StartMlTrainingRequestSchema.parse(input);
    const dataset = await this.datasets.dataset(actor.organizationId, request.datasetId);
    if (!dataset) throw new NotFoundError('MlDataset', request.datasetId);
    const id = newId();
    await this.registry.insertRun({
      id,
      organizationId: actor.organizationId,
      datasetId: dataset.id,
      considerGbm: request.considerGbm,
      createdBy: actor.userId,
    });
    await this.queue.enqueue(actor.organizationId, id);
    const run = (await this.registry.runs(actor.organizationId, 50)).find((row) => row.id === id);
    if (!run) throw new NotFoundError('MlTrainingRun', id);
    return runView(run);
  }

  /** The worker's side: trains in intel and registers the model (or records why it failed). */
  async run(runId: string): Promise<void> {
    const run = await this.registry.run(runId);
    if (run?.status !== 'queued') return;
    await this.registry.updateRun(runId, { status: 'running' });
    try {
      const modelId = await this.train(run.organizationId, run.datasetId, run.considerGbm, run.createdBy);
      await this.registry.updateRun(runId, { status: 'succeeded', modelId, finishedAt: this.clock.now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, runId }, 'model training failed');
      await this.registry.updateRun(runId, {
        status: 'failed',
        error: message.slice(0, 1_000),
        finishedAt: this.clock.now(),
      });
    }
  }

  private async train(
    organizationId: string,
    datasetId: string,
    considerGbm: boolean,
    userId: string | null,
  ) {
    const dataset = await this.datasets.dataset(organizationId, datasetId);
    if (!dataset) throw new NotFoundError('MlDataset', datasetId);
    const bucket = (this.env as ApiEnv).S3_BUCKET_ARTIFACTS;
    const id = newId();
    const keys = Object.fromEntries(
      (Object.keys(FILES) as ArtifactName[]).map((name) => [
        name,
        `ml/models/${organizationId}/${id}/${FILES[name]}`,
      ]),
    ) as Record<ArtifactName, string>;
    const put = (name: ArtifactName) =>
      this.presigner.presignPut(bucket, keys[name], CONTENT_TYPES[name], URL_TTL_SECONDS);
    const result = await this.intel.train({
      datasetId: dataset.id,
      datasetUrl: await this.presigner.presignGet(bucket, dataset.storageKey, URL_TTL_SECONDS),
      datasetSha256: dataset.sha256,
      artifactUrls: {
        model: await put('model'),
        preprocessing: await put('preprocessing'),
        modelCardJson: await put('modelCardJson'),
        modelCardMd: await put('modelCardMd'),
      },
      offer: dataset.offer,
      labelVersion: dataset.labelVersion,
      horizonDays: dataset.horizonDays,
      features: dataset.features,
      considerGbm,
    });
    const model = await this.registry.insertModel({
      id,
      organizationId,
      offer: dataset.offer,
      version: await this.registry.nextVersion(organizationId, dataset.offer),
      kind: result.kind,
      status: 'trained',
      datasetId: dataset.id,
      labelVersion: dataset.labelVersion,
      artifactKeys: keys,
      artifactHashes: result.artifactHashes,
      modelCard: result.modelCard,
      metrics: result.metrics,
      baselineMetrics: result.baselineMetrics,
      spearman: result.spearman,
      warnings: result.warnings,
      trainedBy: userId,
    });
    this.logger.info({ modelId: model.id, kind: model.kind, version: model.version }, 'model registered');
    return model.id;
  }

  async runs(organizationId: string): Promise<MlTrainingRun[]> {
    return (await this.registry.runs(organizationId, 50)).map(runView);
  }

  async models(organizationId: string): Promise<MlModel[]> {
    return (await this.registry.models(organizationId)).map(toModelView);
  }

  async model(organizationId: string, id: string): Promise<MlModel> {
    const model = await this.registry.model(organizationId, id);
    if (!model) throw new NotFoundError('ScoringModel', id);
    return toModelView(model);
  }
}

const runView = (run: Awaited<ReturnType<ModelRegistry['runs']>>[number]): MlTrainingRun => ({
  id: run.id,
  datasetId: run.datasetId,
  offer: run.offer as MlTrainingRun['offer'],
  status: run.status,
  error: run.error,
  modelId: run.modelId,
  createdBy: run.createdBy,
  createdAt: run.createdAt.toISOString(),
  finishedAt: run.finishedAt?.toISOString() ?? null,
});
