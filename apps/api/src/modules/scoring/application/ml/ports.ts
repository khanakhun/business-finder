import type { FeatureVector, MlDataset } from '@bf/contracts';

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
}
export const ML_REPOSITORY = Symbol('MlRepository');

/** Private storage of datasets and model artifacts. */
export const ML_STORAGE = Symbol('MlStorage');
