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
import { BLOCKING, blockingLockKeys, businessLockKeys } from '../../domain/resolution/blocking.ts';
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
  /**
   * The business this record describes (a crawl of its own website, BF-027): linked to it without matching. A
   * record already linked elsewhere stays there (moving it is a manual split).
   */
  readonly targetBusinessId?: string;
  /**
   * Discovery (BF-016): a new place its source reports permanently closed is kept as a record but not
   * added as a business. Other paths (manual adds, website crawls) always link.
   */
  readonly skipClosed?: boolean;
}

export type IngestResult = LinkedIngestResult | SkippedIngestResult;

export interface LinkedIngestResult {
  readonly outcome: Exclude<IngestOutcome, 'failed' | 'skipped_closed'>;
  readonly businessId: string;
  readonly sourceId: string;
  /** Score of the matched business, when merged by matching. */
  readonly score?: MatchScore;
  readonly possibleDuplicates: readonly string[];
  /** Golden fields the ingestion changed on an existing business (empty when unchanged or created). */
  readonly changedFields?: readonly string[];
}

/**
 * A new place its source reports permanently closed: no business is created for it (nothing to sell to), but the
 * record is kept, so the place becomes a business if a later fetch reports it open again. A closed record that
 * matches an existing business still updates it (marked closed, hidden from search).
 */
export interface SkippedIngestResult {
  readonly outcome: 'skipped_closed';
  readonly businessId: null;
  readonly sourceId: string;
  readonly possibleDuplicates: readonly string[];
  readonly changedFields?: readonly string[];
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

  execute(
    input: SourceRecordInput,
    options?: IngestOptions & { skipClosed?: false },
  ): Promise<LinkedIngestResult>;
  execute(input: SourceRecordInput, options: IngestOptions): Promise<IngestResult>;
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
      // Same content and same normalization rules → nothing to do (fetch times excluded).
      const hash = contentHash({
        record: { ...record, fetchedAt: undefined, expiresAt: undefined },
        normalizer: NORMALIZER_VERSION,
        defaultRegion: options.defaultRegion ?? null,
      });
      const unchanged = await this.unchanged(record, hash);
      if (unchanged) return unchanged;
      const classification = await startSpan('ingest.classify', {}, () => this.classify(record, options));
      const normalized: NormalizedSource = {
        ...normalizeSource(record, {
          classification,
          ...(options.defaultRegion ? { defaultRegion: options.defaultRegion } : {}),
        }),
        ...(record.provider === 'manual' ? { submittedByOrgId: options.orgId ?? null } : {}),
      };
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
    // Lock protocol, phase 1: blocking keys (see blocking.ts).
    await this.resolution.lockKeys(blockingLockKeys(normalized));
    // Another worker may have ingested the same record while we waited for the locks.
    const raced = await this.unchanged(record, hash);
    if (raced) return raced;

    const existing = await this.resolution.findSource(record.provider, record.providerRef);
    const manual = record.provider === 'manual';
    const linkedBy = manual ? 'manual' : 'auto';
    const { record: stored } = await this.sources.upsert({
      id: existing?.id ?? options.sourceId ?? newId(),
      businessId: existing?.businessId ?? null,
      provider: record.provider,
      providerRef: record.providerRef,
      payload: storablePayload(record),
      normalized: normalized as unknown as Record<string, unknown>,
      contentHash: hash,
      fetchedAt: new Date(record.fetchedAt),
      expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
      matchConfidence: null,
      linkedBy,
      submittedByOrgId: manual ? (options.orgId ?? null) : null,
    });

    if (stored.businessId) {
      // A known record with new content: recompute its (live) business. Re-linking a record whose content moved to
      // another business is a manual split (see the ticket notes).
      const businessId = await this.lockLive(stored.businessId);
      const changedFields = await this.recompute(businessId);
      return { outcome: 'merged', businessId, sourceId: stored.id, possibleDuplicates: [], changedFields };
    }
    if (options.targetBusinessId) {
      const businessId = await this.lockLive(options.targetBusinessId);
      await this.resolution.linkSource(stored.id, businessId, 1, linkedBy);
      const changedFields = await this.recompute(businessId);
      return { outcome: 'merged', businessId, sourceId: stored.id, possibleDuplicates: [], changedFields };
    }

    let candidateIds = await this.resolution.findCandidateIds(normalized, BLOCKING.maxCandidates);
    if (manual && options.orgId) {
      // A workspace's manual add may only join records it alone tracks: its manual values win survivorship, and
      // must not rewrite facts other workspaces rely on (ADR-0008). Elsewhere it creates its own record.
      const own = await this.resolution.trackedOnlyBy(options.orgId, candidateIds);
      candidateIds = candidateIds.filter((id) => own.has(id));
    }
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

    if (
      decision.kind === 'create' &&
      options.skipClosed &&
      normalized.operatingStatus === 'closed_permanently'
    ) {
      return { outcome: 'skipped_closed', businessId: null, sourceId: stored.id, possibleDuplicates: [] };
    }
    let businessId: string;
    let outcome: LinkedIngestResult['outcome'];
    if (decision.kind === 'match') {
      outcome = 'merged';
      businessId = await this.lockLive(decision.businessId);
      await this.resolution.linkSource(stored.id, businessId, decision.score.total, linkedBy);
      await this.recompute(businessId);
    } else {
      businessId = newId();
      outcome = decision.possible.length > 0 ? 'possible_duplicate' : 'created';
      await this.writer.write(businessId, [normalized], { create: true });
      await this.resolution.linkSource(stored.id, businessId, 1, linkedBy);
    }
    for (const other of decision.possible) {
      await this.resolution.recordPossibleDuplicate(businessId, other.businessId, other.score);
      // Scores only: reasons can quote phone numbers (security.md §7).
      this.logger.debug(
        { businessId, otherId: other.businessId, score: other.score.total },
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

  /**
   * Lock protocol, phase 2: `business:<id>`, then follow merges — a concurrent merge may have retired the business
   * between candidate selection and the lock. Returns the live business to write to.
   */
  private async lockLive(businessId: string): Promise<string> {
    let current = businessId;
    for (let hop = 0; hop < 5; hop++) {
      await this.resolution.lockKeys(businessLockKeys([current]));
      const mergedInto = await this.resolution.mergedInto(current);
      if (mergedInto === undefined) throw new Error(`Business ${current} vanished during ingestion`);
      if (mergedInto === null) return current;
      current = mergedInto;
    }
    throw new Error(`Merge chain too long from business ${businessId}`);
  }

  private async recompute(businessId: string): Promise<readonly string[]> {
    const linked = await this.resolution.listLinkedSources(businessId);
    let changed: readonly string[] = [];
    await this.writer.write(
      businessId,
      linked.map((s) => s.normalized),
      {
        create: false,
        onChanged: (fields) => {
          changed = fields;
        },
      },
    );
    return changed;
  }
}

/** Bumped when normalization changes, so stored records are re-normalized on their next fetch. */
export const NORMALIZER_VERSION = 1;

const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * The provider payload as stored: NUL characters removed (Postgres text cannot hold them) and capped in size
 * (an oversized payload keeps only the normalized view).
 */
export function storablePayload(record: SourceRecord): unknown {
  const raw = record.raw ?? { ...record, raw: undefined };
  const json = JSON.stringify(raw)?.replaceAll('\\u0000', '');
  if (!json) return {};
  if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) return { truncated: true, bytes: Buffer.byteLength(json) };
  return JSON.parse(json);
}
