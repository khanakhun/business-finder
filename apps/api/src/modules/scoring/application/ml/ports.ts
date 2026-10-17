import type {
  FeatureVector,
  MlDataset,
  MlModel,
  MlPreprocessingSpec,
  MlTrainingRun,
  MlTrainRequest,
  MlTrainResult,
  ModelMonitoring,
  ModelPromotion,
  ProspectiveComparison,
  ScoreContribution,
  ScoreReason,
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
  /** Active and shadow models of every workspace (the monthly monitoring sweep). */
  monitored(): Promise<{ organizationId: string; id: string }[]>;
  setStatus(
    organizationId: string,
    id: string,
    status: MlModelRecord['status'],
    promotion?: { by: string | null; at: Date },
  ): Promise<void>;
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

/** Runs a registered model (ONNX): its spec, and raw probabilities for model inputs. */
export interface ModelRuntime {
  spec(model: MlModelRecord): Promise<MlPreprocessingSpec>;
  predict(model: MlModelRecord, rows: readonly Float32Array[]): Promise<number[]>;
}
export const MODEL_RUNTIME = Symbol('ModelRuntime');

export interface ShadowScoreRow {
  readonly organizationId: string;
  readonly businessId: string;
  readonly profileId: string;
  readonly modelId: string;
  readonly probability: number;
  readonly score: number;
  readonly tier: string;
  readonly contributions: ScoreContribution[];
  readonly reasons: ScoreReason[];
  readonly factsHash: string;
  readonly computedAt: Date;
}

export interface ShadowRepository {
  /** Profile → shadow model for the workspace. */
  assignments(organizationId: string): Promise<Map<string, { modelId: string; startedAt: Date }>>;
  assign(organizationId: string, profileId: string, modelId: string, userId: string | null): Promise<void>;
  unassign(organizationId: string, profileId: string): Promise<string | null>;
  /** The latest shadow row's fingerprint per business (to skip unchanged vectors). */
  latestHashes(
    organizationId: string,
    profileId: string,
    businessIds: readonly string[],
  ): Promise<Map<string, { factsHash: string; modelId: string }>>;
  insert(rows: readonly ShadowScoreRow[]): Promise<void>;
  latest(organizationId: string, businessId: string): Promise<ShadowScoreRow[]>;
}
export const SHADOW_REPOSITORY = Symbol('ShadowRepository');

/** What each ranking said about a contact at its time `t0`. */
export interface ScoresAtContact {
  readonly businessId: string;
  readonly activeScore: number | null;
  readonly activeTier: string | null;
  readonly shadowProbability: number | null;
  readonly shadowTier: string | null;
}

export interface PromotionRecord extends Omit<ModelPromotion, 'promotedAt' | 'rolledBackAt'> {
  readonly organizationId: string;
  readonly promotedAt: Date;
  readonly rolledBackAt: Date | null;
}

/** Promotions, monitoring and the reads they need. */
export interface ModelLifecycleRepository {
  scoresAt(
    organizationId: string,
    profileId: string,
    modelId: string,
    contacts: readonly { businessId: string; t0: Date }[],
  ): Promise<ScoresAtContact[]>;
  /** The latest shadow probabilities of the model for the workspace (one per business). */
  shadowProbabilities(organizationId: string, modelId: string): Promise<number[]>;
  /** Feature vectors computed since a date for profiles of the offer (latest per business). */
  recentVectors(organizationId: string, offer: string, since: Date): Promise<FeatureVector[]>;
  insertPromotion(row: Omit<PromotionRecord, 'promotedAt' | 'rolledBackAt'>): Promise<void>;
  latestPromotion(organizationId: string, profileId: string): Promise<PromotionRecord | undefined>;
  promotions(organizationId: string): Promise<PromotionRecord[]>;
  markRolledBack(id: string, by: string | null, at: Date): Promise<void>;
  insertMonitoring(organizationId: string, row: Omit<ModelMonitoring, 'at'>): Promise<void>;
  latestMonitoring(organizationId: string, modelId: string): Promise<ModelMonitoring | undefined>;
}
export const MODEL_LIFECYCLE = Symbol('ModelLifecycleRepository');

export type { ProspectiveComparison };
