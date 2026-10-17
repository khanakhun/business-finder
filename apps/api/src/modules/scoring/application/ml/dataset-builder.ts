import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  type BuildMlDatasetRequest,
  BuildMlDatasetRequestSchema,
  type Clock,
  FEATURE_DEFINITIONS,
  FEATURE_KEYS,
  ML_MIN_LABELLED,
  ML_MIN_POSITIVES,
  type MlDataset,
  type MlReadiness,
  newId,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import type { ObjectStorage } from '../../../platform/storage/object-storage.ts';
import {
  CURRENT_LABEL_VERSION,
  LABEL_DEFINITIONS,
  type Label,
  labelOf,
} from '../../domain/ml/label-definition.ts';
import { type AllowedFeature, assertNoLeakage, CONTEXT_FEATURES } from '../../domain/ml/leakage-guard.ts';
import {
  type ContactRow,
  ML_REPOSITORY,
  ML_STORAGE,
  type MlDatasetRecord,
  type MlRepository,
} from './ports.ts';

// The dataset builder (BF-059): each first contact becomes a row — the score snapshot at or before the contact plus
// the context known then, and its label (positive, negative; censored and bounced rows are counted, not written).
// Every row passes the leakage guard; the file is JSON Lines, gzip, in private storage, hashed, with its manifest.
// Below 300 labelled contacts or 30 positives it refuses and says how far along the data is.

const TYPES = { number: 'numeric', boolean: 'boolean', enum: 'categorical' } as const;

/** Score features (from the snapshot) and the context features, with their types: the only features allowed. */
export const ALLOWED_FEATURES: ReadonlyMap<string, AllowedFeature> = new Map([
  ...FEATURE_KEYS.map(
    (key) =>
      [key, { id: key, origin: 'score_snapshot', type: TYPES[FEATURE_DEFINITIONS[key].type] }] as const,
  ),
  ...CONTEXT_FEATURES.map((feature) => [feature.id, feature] as const),
]);

export interface MlActor {
  readonly organizationId: string;
  readonly userId: string | null;
}

const EPOCH = new Date('2000-01-01T00:00:00Z');

@Injectable()
export class DatasetBuilder {
  constructor(
    @Inject(ML_REPOSITORY) private readonly repository: MlRepository,
    @Inject(ML_STORAGE) private readonly storage: ObjectStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async labelled(organizationId: string, offer: string, from: Date) {
    const definition = LABEL_DEFINITIONS[CURRENT_LABEL_VERSION];
    if (!definition) throw new Error(`No label definition v${CURRENT_LABEL_VERSION}`);
    const now = this.clock.now();
    const contacts = await this.repository.contacts(organizationId, offer, from, now, definition.horizonDays);
    const rows = contacts.map((contact) => ({
      contact,
      label: labelOf(
        { firstContactAt: contact.t0, bounced: contact.bounced, events: contact.events },
        definition,
        now,
      ),
    }));
    return { definition, now, rows };
  }

  async readiness(organizationId: string, offer: MlReadiness['offer']): Promise<MlReadiness> {
    const { definition, rows } = await this.labelled(organizationId, offer, EPOCH);
    const count = (label: Label) => rows.filter((row) => row.label === label).length;
    const positives = count('positive');
    const labelled = positives + count('negative');
    return {
      offer,
      labelVersion: definition.version,
      horizonDays: definition.horizonDays,
      labelled,
      positives,
      censored: count('censored'),
      excluded: count('excluded'),
      required: { labelled: ML_MIN_LABELLED, positives: ML_MIN_POSITIVES },
      ready: labelled >= ML_MIN_LABELLED && positives >= ML_MIN_POSITIVES,
    };
  }

  /** The row's features: the snapshot's score features and the context known at the contact. */
  private features(contact: ContactRow, offer: string) {
    const features: Record<string, number | string | boolean | null> = {};
    for (const key of FEATURE_KEYS) features[key] = contact.snapshot?.features[key] ?? null;
    features.ctx_offer = offer;
    features.ctx_channel = contact.channel;
    features.ctx_locale = contact.locale;
    features.ctx_preview_built = contact.previewAt !== null;
    features.ctx_preview_quality = contact.previewQuality;
    return features;
  }

  async build(actor: MlActor, input: BuildMlDatasetRequest): Promise<MlDataset> {
    const request = BuildMlDatasetRequestSchema.parse(input);
    const from = request.from ? new Date(request.from) : EPOCH;
    const { definition, now, rows } = await this.labelled(actor.organizationId, request.offer, from);
    const kept = rows.filter((row) => row.label === 'positive' || row.label === 'negative');
    const positives = kept.filter((row) => row.label === 'positive').length;
    if (kept.length < ML_MIN_LABELLED || positives < ML_MIN_POSITIVES)
      throw new ValidationError(
        `Not enough outcomes yet: ${kept.length}/${ML_MIN_LABELLED} contacts, ${positives}/${ML_MIN_POSITIVES} positives.`,
        [],
        {
          details: {
            reason: 'NOT_ENOUGH_DATA',
            labelled: kept.length,
            positives,
            required: { labelled: ML_MIN_LABELLED, positives: ML_MIN_POSITIVES },
          },
        },
      );
    const lines: string[] = [];
    for (const { contact, label } of kept) {
      const features = this.features(contact, request.offer);
      assertNoLeakage(
        {
          t0: contact.t0,
          snapshotAt: contact.snapshot?.computedAt ?? null,
          previewAt: contact.previewAt,
          features,
        },
        ALLOWED_FEATURES,
      );
      lines.push(
        JSON.stringify({
          t0: contact.t0.toISOString(),
          label: label === 'positive' ? 1 : 0,
          // The rule-based score at the contact: the baseline the model must beat.
          baseline_score: contact.snapshot?.score ?? null,
          features,
        }),
      );
    }
    const file = gzipSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
    const sha256 = createHash('sha256').update(file).digest('hex');
    const id = newId();
    const storageKey = `ml/datasets/${actor.organizationId}/${id}.jsonl.gz`;
    await this.storage.put(storageKey, file, 'application/gzip');
    const record = await this.repository.insertDataset({
      id,
      organizationId: actor.organizationId,
      offer: request.offer,
      labelVersion: definition.version,
      horizonDays: definition.horizonDays,
      from,
      to: now,
      counts: {
        rows: kept.length,
        positives,
        negatives: kept.length - positives,
        censored: rows.filter((row) => row.label === 'censored').length,
        excluded: rows.filter((row) => row.label === 'excluded').length,
      },
      features: [...ALLOWED_FEATURES.values()].map((feature) => ({ id: feature.id, type: feature.type })),
      sha256,
      storageKey,
      createdBy: actor.userId,
    });
    return toView(record);
  }

  async list(organizationId: string): Promise<MlDataset[]> {
    return (await this.repository.datasets(organizationId, 50)).map(toView);
  }
}

const toView = (record: MlDatasetRecord): MlDataset => ({
  id: record.id,
  offer: record.offer,
  labelVersion: record.labelVersion,
  horizonDays: record.horizonDays,
  from: record.from.toISOString(),
  to: record.to.toISOString(),
  counts: record.counts,
  features: record.features,
  sha256: record.sha256,
  createdAt: record.createdAt.toISOString(),
});
