import type { AnalyticsFactType } from '@bf/contracts';

// Ports of analytics (BF-058). The facts store reads source rows into facts (live: one row an event names; backfill:
// everything since a date) and answers compiled queries; the application decides what and when.

export type FactSourceName =
  | 'businessTracked'
  | 'generationFinished'
  | 'previewPublished'
  | 'siteViewsDaily'
  | 'leadCaptured'
  | 'emailSent'
  | 'replyTriaged'
  | 'pipelineFromActivities'
  | 'manualContact'
  | 'discoveryFinished'
  | 'llmCosts'
  | 'providerCosts';

export interface FactScope {
  readonly organizationId?: string | undefined;
  readonly id?: string | undefined;
  readonly since?: Date | undefined;
}

/** A fact built from an event payload (no source row). */
export interface PayloadFact {
  readonly organizationId: string;
  readonly occurredAt: Date;
  readonly eventType: AnalyticsFactType;
  readonly sourceKey: string;
  readonly businessId?: string | null;
  readonly siteId?: string | null;
  readonly messageId?: string | null;
  readonly offer?: string | null;
  readonly scoreTier?: string | null;
  readonly scoreValue?: number | null;
  readonly profileVersion?: number | null;
  readonly outcome?: string | null;
  readonly dims?: Record<string, unknown>;
  readonly count?: number;
}

export interface FactsQuery {
  readonly organizationId: string;
  readonly metrics: readonly string[];
  readonly dimensions: readonly string[];
  readonly filters: Readonly<Record<string, readonly string[]>>;
  readonly from: Date;
  readonly to: Date;
  readonly timeZone: string;
  readonly limit: number;
}

export interface FactsStore {
  /** Reads a source's rows into facts; returns how many were new. */
  ingest(source: FactSourceName, scope: FactScope): Promise<number>;
  ingestPayload(fact: PayloadFact): Promise<number>;
  ingestBounce(scope: FactScope, bounce: { at: Date; permanent: boolean }): Promise<number>;
  /**
   * Runs a validated query under a statement timeout: rows of `d0…` (dimension values) and `m_<metric>` (base
   * metric values). Throws `AnalyticsQueryTooHeavyError` past the timeout.
   */
  query(query: FactsQuery, timeoutMs: number): Promise<Record<string, unknown>[]>;
  /** The oldest event not yet delivered to subscribers (facts are complete before it); null when none waits. */
  oldestPendingEvent(): Promise<Date | null>;
  /** Display labels of dimension values (categories, areas, templates, mailboxes, members). */
  labels(
    organizationId: string,
    dimension: string,
    values: readonly string[],
    locale: 'en' | 'fr',
  ): Promise<Record<string, string>>;
}
export const FACTS_STORE = Symbol('FactsStore');

export interface ReconcileCount {
  readonly organizationId: string;
  readonly metric: 'emails_sent' | 'leads' | 'jobs_finished';
  readonly facts: number;
  readonly source: number;
}

export interface CohortRow {
  readonly week: string;
  readonly contacted: number;
  readonly replied: number;
  readonly positive: number;
  readonly meetings: number;
  readonly won: number;
}

export interface DailyTrendRow {
  readonly day: string;
  readonly eventType: string;
  readonly facts: number;
  readonly units: number;
  readonly costUsd: number;
}

/** Upkeep of the facts: partitions, polled sources' watermarks, the daily rollup, reconciliation counts. */
export interface FactsMaintenance {
  /** Runs `work` when no other worker holds `name` (a transaction-scoped advisory lock); false when skipped. */
  exclusively(name: string, work: () => Promise<void>): Promise<boolean>;
  ensurePartitions(monthsAhead: number): Promise<void>;
  watermark(source: string): Promise<Date | null>;
  setWatermark(source: string, at: Date): Promise<void>;
  /** Rebuilds the daily rollup for the days of facts ingested since `since`; returns the days rebuilt. */
  refreshDaily(since: Date): Promise<number>;
  reconcileCounts(from: Date, to: Date): Promise<ReconcileCount[]>;
  cohorts(organizationId: string, from: Date, to: Date, timeZone: string): Promise<CohortRow[]>;
  /** Daily additive totals from the rollup. */
  daily(organizationId: string, from: string, to: string): Promise<DailyTrendRow[]>;
}
export const FACTS_MAINTENANCE = Symbol('FactsMaintenance');
