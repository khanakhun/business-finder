import {
  type IngestOutcome,
  type MatchScore,
  newId,
  type SourceRecord,
  type SourceRecordInput,
  SourceRecordSchema,
  TAXONOMY_PROVIDERS,
  type TaxonomyProvider,
  ValidationError,
} from '@bf/contracts';
import { type DbClient, runInTransaction } from '@bf/db';
import { type Logger, metrics, startSpan } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../../../platform/config/app-env.ts';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import { LOGGER } from '../../../platform/logging/logger.ts';
import { BLOCKING, blockingLockKeys } from '../../domain/resolution/blocking.ts';
import {
  DEFAULT_THRESHOLDS,
  decideMatch,
  type ResolutionThresholds,
} from '../../domain/resolution/decision.ts';
import { scoreMatch } from '../../domain/resolution/match-scorer.ts';
import {
  type CategoryClassificationSnapshot,
  type NormalizedSource,
  normalizeSource,
} from '../../domain/resolution/normalized-source.ts';
import { contentHash } from '../content-hash.ts';
import { SOURCE_RECORD_REPOSITORY, type SourceRecordRepository } from '../ports.ts';
import { CategoryClassifier } from '../taxonomy/category-classifier.ts';
import { TaxonomyCache } from '../taxonomy/taxonomy-cache.ts';
import { GoldenRecordWriter } from './golden-record.writer.ts';
import { RESOLUTION_REPOSITORY, type ResolutionRepository } from './ports.ts';

export interface IngestOptions {
  /** Workspace on whose behalf (LLM classification budget, attribution of manual records). */
  readonly orgId?: string | null;
  /** Region for national phone formats when the record has no country. */
  readonly defaultRegion?: string;
  /** Id for a new source row (manual adds use it as their provider ref). */
  readonly sourceId?: string;
  /** `false` classifies without the LLM step (interactive paths). */
  readonly classifyWithModel?: boolean;
}

export interface IngestResult {
  readonly outcome: Exclude<IngestOutcome, 'failed'>;
  readonly businessId: string;
  readonly sourceId: string;
  /** Score of the matched business, when merged by matching. */
  readonly score?: MatchScore;
  readonly possibleDuplicates: readonly string[];
}

/** French-speaking places get French classification hints. */
const FRENCH_COUNTRIES = new Set([
  'FR',
  'BL',
  'MF',
  'GP',
  'MQ',
  'GF',
  'RE',
  'YT',
  'PM',
  'NC',
  'PF',
  'WF',
  'BE',
  'CH',
  'LU',
  'MC',
  'CA',
  'HT',
]);

const decisions = () =>
  metrics.counter({
    name: 'bf_ingest_records_total',
    help: 'Source records ingested, by outcome',
    labelNames: ['provider', 'outcome'],
  });
const durations = () =>
  metrics.histogram({ name: 'bf_ingest_record_duration_seconds', help: 'Time to ingest one source record' });

/**
 * Ingests one source record (BF-016): normalize → persist → block → score → decide → merge → emit. Idempotent: the
 * same content again only refreshes `fetched_at`. Classification (which may call the LLM) runs before the
 * transaction; everything after runs in one transaction under advisory locks on the record's blocking keys, so
 * concurrent ingestions of the same business cannot both create it.
 */
@Injectable()
export class IngestSourceRecordCommand {
  private readonly thresholds: ResolutionThresholds;

  constructor(
    @Inject(RESOLUTION_REPOSITORY) private readonly resolution: ResolutionRepository,
    @Inject(SOURCE_RECORD_REPOSITORY) private readonly sources: SourceRecordRepository,
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(APP_ENV) env: AppEnv,
    private readonly writer: GoldenRecordWriter,
    private readonly classifier: CategoryClassifier,
    private readonly taxonomy: TaxonomyCache,
  ) {
    this.thresholds = {
      ...DEFAULT_THRESHOLDS,
      match: env.RESOLUTION_MATCH_THRESHOLD,
      possible: env.RESOLUTION_POSSIBLE_THRESHOLD,
    };
  }

  async execute(input: SourceRecordInput, options: IngestOptions = {}): Promise<IngestResult> {
    const started = performance.now();
    const parsed = SourceRecordSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        'Invalid source record.',
        parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String), message: i.message })),
      );
    }
    const record = parsed.data;
    const result = await startSpan('ingest.record', { 'bf.provider': record.provider }, async (span) => {
      const hash = contentHash({ ...record, fetchedAt: undefined, expiresAt: undefined });
      const unchanged = await this.unchanged(record, hash);
      if (unchanged) return unchanged;
      const classification = await startSpan('ingest.classify', {}, () => this.classify(record, options));
      const normalized = normalizeSource(record, {
        classification,
        ...(options.defaultRegion ? { defaultRegion: options.defaultRegion } : {}),
      });
      const resolved = await runInTransaction(this.db, () => this.resolve(record, normalized, hash, options));
      span.setAttribute('bf.ingest.outcome', resolved.outcome);
      return resolved;
    });
    decisions().inc({ provider: record.provider, outcome: result.outcome });
    durations().observe((performance.now() - started) / 1000);
    return result;
  }

  /** Same content already linked: refresh the fetch time only. */
  private async unchanged(record: SourceRecord, hash: string): Promise<IngestResult | undefined> {
    const existing = await this.resolution.findSource(record.provider, record.providerRef);
    if (!existing?.businessId || existing.contentHash !== hash) return undefined;
    await this.resolution.touchSource(
      existing.id,
      new Date(record.fetchedAt),
      record.expiresAt ? new Date(record.expiresAt) : null,
    );
    return {
      outcome: 'unchanged',
      businessId: existing.businessId,
      sourceId: existing.id,
      possibleDuplicates: [],
    };
  }

  private async classify(
    record: SourceRecord,
    options: IngestOptions,
  ): Promise<CategoryClassificationSnapshot> {
    const provider = (TAXONOMY_PROVIDERS as readonly string[]).includes(record.provider)
      ? (record.provider as TaxonomyProvider)
      : null;
    const country = record.address?.countryCode?.toUpperCase() ?? options.defaultRegion?.toUpperCase();
    const result = await this.classifier.classify({
      providerCategories: provider
        ? record.providerCategories.map((c) => ({
            provider,
            key: c.key,
            ...(c.label ? { label: c.label } : {}),
          }))
        : [],
      name: record.name,
      locale: country && FRENCH_COUNTRIES.has(country) ? 'fr' : 'en',
      orgId: options.orgId ?? null,
      useModel: options.classifyWithModel !== false,
    });
    return { primary: result.primary, secondary: [...result.secondary], confidence: result.confidence };
  }

  private async resolve(
    record: SourceRecord,
    normalized: NormalizedSource,
    hash: string,
    options: IngestOptions,
  ): Promise<IngestResult> {
    await this.resolution.lockKeys(blockingLockKeys(normalized));
    // Another worker may have ingested the same record while we waited for the locks.
    const raced = await this.unchanged(record, hash);
    if (raced) return raced;

    const existing = await this.resolution.findSource(record.provider, record.providerRef);
    const manual = record.provider === 'manual';
    const { record: stored } = await this.sources.upsert({
      id: existing?.id ?? options.sourceId ?? newId(),
      businessId: existing?.businessId ?? null,
      provider: record.provider,
      providerRef: record.providerRef,
      payload: record.raw ?? { ...record, raw: undefined },
      normalized: normalized as unknown as Record<string, unknown>,
      contentHash: hash,
      fetchedAt: new Date(record.fetchedAt),
      expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
      matchConfidence: null,
      linkedBy: manual ? 'manual' : 'auto',
      submittedByOrgId: manual ? (options.orgId ?? null) : null,
    });

    if (stored.businessId) {
      // A known record with new content: recompute its business.
      await this.recompute(stored.businessId, options);
      return {
        outcome: 'merged',
        businessId: stored.businessId,
        sourceId: stored.id,
        possibleDuplicates: [],
      };
    }

    const candidateIds = await this.resolution.findCandidateIds(normalized, BLOCKING.maxCandidates);
    const profiles = await this.resolution.loadProfiles(candidateIds);
    const snapshot = await this.taxonomy.get();
    const categoryPath = normalized.categories?.primary
      ? (snapshot.bySlug.get(normalized.categories.primary)?.path ?? null)
      : null;
    const scored = profiles.map((profile) => ({
      businessId: profile.businessId,
      score: scoreMatch(normalized, categoryPath, profile),
    }));
    const decision = decideMatch(scored, record.provider, this.thresholds);

    let businessId: string;
    let outcome: IngestResult['outcome'];
    if (decision.kind === 'match') {
      businessId = decision.businessId;
      outcome = 'merged';
      await this.resolution.linkSource(
        stored.id,
        businessId,
        decision.score.total,
        manual ? 'manual' : 'auto',
      );
      await this.recompute(businessId, options);
    } else {
      businessId = newId();
      outcome = decision.possible.length > 0 ? 'possible_duplicate' : 'created';
      await this.writer.write(businessId, [normalized], {
        create: true,
        submittedByOrgId: options.orgId ?? null,
      });
      await this.resolution.linkSource(stored.id, businessId, 1, manual ? 'manual' : 'auto');
    }
    for (const other of decision.possible) {
      await this.resolution.recordPossibleDuplicate(businessId, other.businessId, other.score);
      this.logger.debug(
        { businessId, otherId: other.businessId, score: other.score.total, reasons: other.score.reasons },
        'possible duplicate',
      );
    }
    return {
      outcome,
      businessId,
      sourceId: stored.id,
      ...(decision.kind === 'match' ? { score: decision.score } : {}),
      possibleDuplicates: decision.possible.map((p) => p.businessId),
    };
  }

  private async recompute(businessId: string, options: IngestOptions): Promise<void> {
    const linked = await this.resolution.listLinkedSources(businessId);
    await this.writer.write(
      businessId,
      linked.map((s) => s.normalized),
      { create: false, submittedByOrgId: options.orgId ?? null },
    );
  }
}
