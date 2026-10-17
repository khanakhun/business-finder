// The leakage guard (BF-059): only features known at the decision time `t0` may enter a dataset. Each allowed
// feature says where its value comes from; a snapshot computed after `t0`, or any feature not on the allowlist
// (views, replies, later enrichment), is refused — the dataset build fails rather than train on the future.

export type FeatureOrigin =
  /** A score feature from the snapshot taken at or before `t0`. */
  | 'score_snapshot'
  /** Known when the contact was made (the offer, the channel, the language). */
  | 'contact'
  /** About the preview built before the contact (its existence and quality score). */
  | 'preview_before_contact';

export interface AllowedFeature {
  readonly id: string;
  readonly origin: FeatureOrigin;
  readonly type: 'numeric' | 'categorical' | 'boolean';
}

/** Context features beyond the score snapshot, all known at `t0`. */
export const CONTEXT_FEATURES: readonly AllowedFeature[] = [
  { id: 'ctx_offer', origin: 'contact', type: 'categorical' },
  { id: 'ctx_channel', origin: 'contact', type: 'categorical' },
  { id: 'ctx_locale', origin: 'contact', type: 'categorical' },
  { id: 'ctx_preview_built', origin: 'preview_before_contact', type: 'boolean' },
  { id: 'ctx_preview_quality', origin: 'preview_before_contact', type: 'numeric' },
];

export class LeakageError extends Error {}

export interface DatasetRow {
  readonly t0: Date;
  /** When the score snapshot was computed (must not be after `t0`). */
  readonly snapshotAt: Date | null;
  /** When the preview facts were observed (must be before `t0`). */
  readonly previewAt: Date | null;
  readonly features: Readonly<Record<string, number | string | boolean | null>>;
}

/** Throws when a row carries a feature off the allowlist or a value observed after its `t0`. */
export function assertNoLeakage(row: DatasetRow, allowed: ReadonlyMap<string, AllowedFeature>): void {
  for (const id of Object.keys(row.features))
    if (!allowed.has(id)) throw new LeakageError(`Feature ${id} is not known at decision time`);
  if (row.snapshotAt && row.snapshotAt.getTime() > row.t0.getTime())
    throw new LeakageError('The score snapshot was computed after the contact');
  if (row.previewAt && row.previewAt.getTime() >= row.t0.getTime())
    throw new LeakageError('The preview facts were observed after the contact');
}
