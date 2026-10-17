import type {
  FeatureVector,
  MlDataset,
  MlModel,
  MlTrainingRun,
  MlTrainRequest,
  MlTrainResult,
} from '@bf/contracts';

// Ports of the outcome-trained scoring (BF-059).

/** A workspace's first contact with a business, with what is known at it and what followed. */
export interface ContactRow {
  readonly businessId: string;
  readonly t0: Date;
  readonly channel: string;
  readonly locale: string | null;
  readonly bounced: boolean;
  readonly events: readonly { at: Date; kind: 'reply' | 'lead' | 'stage'; value: string }[];
  /** The latest score snapshot for the offer at or before `t0`. */
  readonly snapshot: {
    readonly features: FeatureVector;
    readonly computedAt: Date;
    readonly score: number;
    readonly tier: string;
  } | null;
  readonly previewAt: Date | null;
  readonly previewQuality: number | null;
}

export interface MlDatasetRecord extends Omit<MlDataset, 'from' | 'to' | 'createdAt'> {
  readonly organizationId: string;
  readonly from: Date;
  readonly to: Date;
  readonly storageKey: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export interface MlRepository {
  /** First contacts (ever) made in `[from, to)`, with up to `horizonDays` of what followed. */
  contacts(
    organizationId: string,
    offer: string,
    from: Date,
    to: Date,
    horizonDays: number,
  ): Promise<ContactRow[]>;
  insertDataset(row: Omit<MlDatasetRecord, 'createdAt'>): Promise<MlDatasetRecord>;
  datasets(organizationId: string, limit: number): Promise<MlDatasetRecord[]>;
  dataset(organizationId: string, id: string): Promise<MlDatasetRecord | undefined>;
}

export type ArtifactName = 'model' | 'preprocessing' | 'modelCardJson' | 'modelCardMd';

export interface MlModelRecord extends Omit<MlModel, 'trainedAt' | 'promotedAt'> {
  readonly organizationId: string;
  readonly artifactKeys: Readonly<Record<ArtifactName, string>>;
  readonly artifactHashes: Readonly<Record<ArtifactName, string>>;
  readonly trainedAt: Date;
  readonly promotedAt: Date | null;
}

export interface MlTrainingRunRecord extends Omit<MlTrainingRun, 'createdAt' | 'finishedAt' | 'offer'> {
  readonly organizationId: string;
  readonly considerGbm: boolean;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

/** The model registry (immutable models) and their training runs. */
export interface ModelRegistry {
  nextVersion(organizationId: string, offer: string): Promise<number>;
  insertModel(row: Omit<MlModelRecord, 'trainedAt' | 'promotedAt' | 'promotedBy'>): Promise<MlModelRecord>;
  model(organizationId: string, id: string): Promise<MlModelRecord | undefined>;
  models(organizationId: string): Promise<MlModelRecord[]>;
  insertRun(
    row: Pick<MlTrainingRunRecord, 'id' | 'organizationId' | 'datasetId' | 'considerGbm' | 'createdBy'>,
  ): Promise<void>;
  run(id: string): Promise<MlTrainingRunRecord | undefined>;
  updateRun(
    id: string,
    patch: Partial<Pick<MlTrainingRunRecord, 'status' | 'error' | 'modelId' | 'finishedAt'>>,
  ): Promise<void>;
  runs(organizationId: string, limit: number): Promise<(MlTrainingRunRecord & { offer: string })[]>;
}
export const MODEL_REGISTRY = Symbol('ModelRegistry');

/** Training in intel (POST /v1/ml/train). */
export interface ModelTrainerPort {
  train(request: MlTrainRequest): Promise<MlTrainResult>;
}
export const MODEL_TRAINER_PORT = Symbol('ModelTrainerPort');

export interface TrainingQueue {
  enqueue(organizationId: string, runId: string): Promise<void>;
}
export const TRAINING_QUEUE = Symbol('TrainingQueue');
export const ML_REPOSITORY = Symbol('MlRepository');

/** Private storage of datasets and model artifacts. */
export const ML_STORAGE = Symbol('MlStorage');
