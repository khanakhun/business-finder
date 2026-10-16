import { createHash } from 'node:crypto';
import type { Clock, EnrichmentSkipReason } from '@bf/contracts';
import type { IngestSourceRecordCommand, ReplaceWebsiteMediaCommand } from '../../../business-graph/index.ts';
import type {
  NoSolicitationMarkers,
  SiteIntelPort,
  WebsiteSnapshotRepository,
} from '../../application/ports.ts';
import type {
  EnrichmentStep,
  EnrichmentSubject,
  StepExecution,
  StepOutput,
  StepResult,
} from '../../domain/enrichment-step.ts';
import { websiteMedia, websiteSourceRecord } from '../../domain/website-source.ts';

export interface SiteIntelStepOptions {
  readonly intel: SiteIntelPort;
  readonly snapshots: WebsiteSnapshotRepository;
  readonly media: Pick<ReplaceWebsiteMediaCommand, 'execute'>;
  readonly markers: NoSolicitationMarkers;
  readonly ingest: Pick<IngestSourceRecordCommand, 'execute'>;
  readonly clock: Clock;
  readonly ttlDays: number;
  readonly costUsd: number;
}

const DAY_MS = 24 * 3_600_000;
/** A site that could not be read is tried again sooner than a readable one. */
const UNREADABLE_TTL_DAYS = 2;

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * `site_intel` (BF-027, the first step through the registry): crawls the business's website with intel (BF-026),
 * stores a snapshot (artifacts stay in object storage under `sites/<businessId>/<runId>/`), routes what the site
 * says through ingestion as a `website` source (provenance; manual values win), and records logo and image
 * candidates as external media.
 */
export class SiteIntelStep implements EnrichmentStep {
  readonly id = 'site_intel' as const;
  readonly dependsOn = [] as const;
  readonly costCategory = 'free' as const;
  readonly ttlDays: number;

  constructor(private readonly options: SiteIntelStepOptions) {
    this.ttlDays = options.ttlDays;
  }

  appliesTo(subject: EnrichmentSubject): true | EnrichmentSkipReason {
    return subject.websiteUrl ? true : 'no_website';
  }

  /** The site's address: a changed website is never "fresh". */
  inputHash(subject: EnrichmentSubject): string {
    return hash({ url: subject.websiteUrl }).slice(0, 32);
  }

  estimateCost(): number {
    return this.options.costUsd;
  }

  /** A crawl that found the site down (DNS, timeout, blocked) is stale after two days, not the full TTL. */
  isStale(last: StepOutput, now: Date): boolean {
    const reachability = last.outputRef?.reachability;
    const readable = reachability === 'ok' || reachability === 'redirected';
    const ttlDays = readable ? this.ttlDays : Math.min(this.ttlDays, UNREADABLE_TTL_DAYS);
    return now.getTime() - last.finishedAt.getTime() >= ttlDays * DAY_MS;
  }

  async execute(execution: StepExecution): Promise<StepResult> {
    const { subject } = execution;
    if (!subject.websiteUrl) return { outcome: 'skipped', reason: 'no_website', costUsd: 0 };
    const intel = await this.options.intel.analyse(
      {
        url: subject.websiteUrl,
        artifactPrefix: `sites/${subject.businessId}/${execution.runId}`,
        localesHint: subject.locales,
        countryHint: subject.countryCode,
      },
      execution.signal,
    );
    const { requestedUrl: _requested, durationMs: _duration, ...stored } = intel;
    // What the site says, not when or how fast we read it: an identical re-crawl hashes the same.
    const { fetchedAt: _fetched, screenshots: _shots, warnings: _warnings, pages, ...facts } = stored;
    const snapshot = await this.options.snapshots.insert({
      businessId: subject.businessId,
      url: subject.websiteUrl,
      runId: execution.runId,
      contentHash: hash({ ...facts, pages: pages.map(({ markdownKey: _key, ...page }) => page) }),
      intel: stored,
    });
    if (intel.noSolicitation.detected && intel.noSolicitation.pageUrl) {
      // Sticky (compliance): recorded whenever seen; a later crawl that misses it never clears it.
      await this.options.markers.record(
        subject.businessId,
        {
          pageUrl: intel.noSolicitation.pageUrl,
          phrases: intel.noSolicitation.phrases,
          snippet: intel.noSolicitation.snippet,
          snapshotId: snapshot.id,
        },
        this.options.clock.now(),
      );
    }
    let changedFields: readonly string[] = [];
    const record = websiteSourceRecord(intel, subject, intel.fetchedAt);
    if (record) {
      const result = await this.options.ingest.execute(record, {
        orgId: execution.organizationId,
        targetBusinessId: subject.businessId,
        ...(subject.countryCode ? { defaultRegion: subject.countryCode } : {}),
        classifyWithModel: false,
      });
      changedFields = result.changedFields ?? [];
    }
    if (record) {
      await this.options.media.execute(
        subject.businessId,
        websiteMedia(intel),
        subject.locales[0] === 'fr' ? 'fr' : 'en',
      );
    }
    return {
      outcome: 'done',
      costUsd: this.options.costUsd,
      outputRef: {
        snapshotId: snapshot.id,
        reachability: intel.reachability,
        screenshots: { desktopKey: intel.screenshots.desktopKey, mobileKey: intel.screenshots.mobileKey },
      },
      changedFields,
    };
  }
}
