import {
  DiscoveryRunCompleted,
  type DomainEvent,
  GenerationJobStatusChanged,
  ManualContactLogged,
  OrgBusinessStatusChanged,
  OrgBusinessTracked,
  OutreachMessageBounced,
  OutreachMessageSent,
  OutreachReplyTriaged,
  ScoreUpdated,
  SiteLeadCaptured,
  SitePublished,
  SiteViewed,
  UnsubscribeConfirmed,
} from '@bf/contracts';
import { metrics } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { type AnyEventDefinition, OnDomainEvent } from '../../platform/events/on-domain-event.decorator.ts';
import { FACTS_STORE, type FactSourceName, type FactsStore } from './ports.ts';

type AnyDomainEvent = DomainEvent<AnyEventDefinition>;

// Fact capture (BF-058, event-sourced read model): each business event becomes one fact, written once (its source
// key) with the business's dimensions as they are now — at the event, not later. Events naming a source row read it
// (the backfill's SQL); the others carry what the fact needs. Re-delivered events change nothing.

const ingested = () =>
  metrics.counter({
    name: 'bf_analytics_facts_ingested_total',
    help: 'Analytics facts written from domain events, by fact type',
    labelNames: ['type'],
  });

const lag = () =>
  metrics.histogram({
    name: 'bf_analytics_ingest_lag_seconds',
    help: 'Delay between a domain event and its analytics fact',
    buckets: [1, 5, 15, 30, 60, 120, 300, 900],
  });

const SETTLED = new Set(['succeeded', 'needs_review', 'failed', 'cancelled']);

/** Events whose fact is read from the row they name. */
const BY_ROW: Record<string, { source: FactSourceName; id: (payload: Record<string, unknown>) => string }> = {
  [OrgBusinessTracked.type]: { source: 'businessTracked', id: (p) => String(p.businessId) },
  [SiteLeadCaptured.type]: { source: 'leadCaptured', id: (p) => String(p.leadId) },
  [OutreachMessageSent.type]: { source: 'emailSent', id: (p) => String(p.messageId) },
  [OutreachReplyTriaged.type]: { source: 'replyTriaged', id: (p) => String(p.inboundId) },
  [ManualContactLogged.type]: { source: 'manualContact', id: (p) => String(p.logId) },
  [DiscoveryRunCompleted.type]: { source: 'discoveryFinished', id: (p) => String(p.runId) },
};

@Injectable()
export class FactIngestor {
  constructor(@Inject(FACTS_STORE) private readonly store: FactsStore) {}

  private done(event: AnyDomainEvent, type: string, written: number) {
    if (written === 0) return;
    ingested().inc({ type }, written);
    lag().observe(Math.max(0, (Date.now() - Date.parse(event.occurredAt)) / 1_000));
  }

  @OnDomainEvent(
    [
      OrgBusinessTracked,
      SiteLeadCaptured,
      OutreachMessageSent,
      OutreachReplyTriaged,
      ManualContactLogged,
      DiscoveryRunCompleted,
    ],
    { id: 'analytics.facts-from-rows' },
  )
  async fromRow(event: AnyDomainEvent): Promise<void> {
    const route = BY_ROW[event.type];
    if (!route || !event.orgId) return;
    const id = route.id(event.payload as Record<string, unknown>);
    this.done(
      event,
      route.source,
      await this.store.ingest(route.source, { organizationId: event.orgId, id }),
    );
  }

  @OnDomainEvent(GenerationJobStatusChanged, { id: 'analytics.facts-generation' })
  async generation(event: DomainEvent<typeof GenerationJobStatusChanged>): Promise<void> {
    if (!event.orgId || !SETTLED.has(event.payload.to)) return;
    const written = await this.store.ingest('generationFinished', {
      organizationId: event.orgId,
      id: event.payload.jobId,
    });
    this.done(event, 'generation_finished', written);
  }

  @OnDomainEvent(SitePublished, { id: 'analytics.facts-preview' })
  async published(event: DomainEvent<typeof SitePublished>): Promise<void> {
    if (!event.orgId || event.payload.environment !== 'preview') return;
    const written = await this.store.ingest('previewPublished', {
      organizationId: event.orgId,
      id: event.payload.publicationId,
    });
    this.done(event, 'preview_published', written);
  }

  @OnDomainEvent(SiteViewed, { id: 'analytics.facts-views' })
  async viewed(event: DomainEvent<typeof SiteViewed>): Promise<void> {
    if (!event.orgId) return;
    const { siteId, businessId, hourStart, pageViews, uniqueEstimate } = event.payload;
    const written = await this.store.ingestPayload({
      organizationId: event.orgId,
      occurredAt: new Date(hourStart),
      eventType: 'site_viewed',
      sourceKey: `site_viewed:${siteId}:${hourStart}`,
      businessId,
      siteId,
      dims: { unique: uniqueEstimate },
      count: pageViews,
    });
    this.done(event, 'site_viewed', written);
  }

  @OnDomainEvent(OutreachMessageBounced, { id: 'analytics.facts-bounce' })
  async bounced(event: DomainEvent<typeof OutreachMessageBounced>): Promise<void> {
    if (!event.orgId) return;
    const written = await this.store.ingestBounce(
      { organizationId: event.orgId, id: event.payload.messageId },
      { at: new Date(event.occurredAt), permanent: event.payload.permanent },
    );
    this.done(event, 'email_bounced', written);
  }

  @OnDomainEvent(UnsubscribeConfirmed, { id: 'analytics.facts-unsubscribe' })
  async unsubscribed(event: DomainEvent<typeof UnsubscribeConfirmed>): Promise<void> {
    if (!event.orgId) return;
    const written = await this.store.ingestPayload({
      organizationId: event.orgId,
      occurredAt: new Date(event.occurredAt),
      eventType: 'unsubscribed',
      sourceKey: `unsubscribed:${event.payload.tokenId}`,
      businessId: event.payload.businessId,
      messageId: event.payload.outboundMessageId,
      outcome: event.payload.oneClick ? 'one_click' : 'link',
    });
    this.done(event, 'unsubscribed', written);
  }

  @OnDomainEvent(OrgBusinessStatusChanged, { id: 'analytics.facts-pipeline' })
  async pipeline(event: DomainEvent<typeof OrgBusinessStatusChanged>): Promise<void> {
    if (!event.orgId) return;
    const { businessId, from, to, automatic } = event.payload;
    // The same key as the timeline's activity (its source event), which the backfill reads.
    const written = await this.store.ingestPayload({
      organizationId: event.orgId,
      occurredAt: new Date(event.occurredAt),
      eventType: 'pipeline_changed',
      sourceKey: `pipeline_changed:${event.id}`,
      businessId,
      outcome: to,
      dims: { from, automatic },
    });
    this.done(event, 'pipeline_changed', written);
  }

  /** The primary profile's score (its tier is the business's tier); other profiles are not analytics dimensions. */
  @OnDomainEvent(ScoreUpdated, { id: 'analytics.facts-score' })
  async scored(event: DomainEvent<typeof ScoreUpdated>): Promise<void> {
    if (!event.orgId || !event.payload.primary) return;
    const { businessId, tier, score, profileVersion, offer, previousTier } = event.payload;
    const written = await this.store.ingestPayload({
      organizationId: event.orgId,
      occurredAt: new Date(event.occurredAt),
      eventType: 'score_updated',
      sourceKey: `score_updated:${event.id}`,
      businessId,
      offer,
      scoreTier: tier,
      scoreValue: score,
      profileVersion,
      dims: { previousTier },
    });
    this.done(event, 'score_updated', written);
  }
}
