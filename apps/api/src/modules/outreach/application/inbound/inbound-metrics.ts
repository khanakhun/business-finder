import { metrics } from '@bf/observability';

// Reply pipeline metrics (BF-054): what was kept or dropped, sync health and lag, triage outcomes.

export const inboundMetrics = {
  ingested: () =>
    metrics.counter({
      name: 'bf_outreach_inbound_total',
      help: 'Inbound messages stored, by kind (human, auto_reply, bounce, unsubscribe_mailto)',
      labelNames: ['kind'],
    }),
  ignored: () =>
    metrics.counter({
      name: 'bf_outreach_inbound_ignored_total',
      help: 'Mailbox messages dropped before storage (not outreach), by reason',
      labelNames: ['reason'],
    }),
  lag: () =>
    metrics.histogram({
      name: 'bf_outreach_sync_lag_seconds',
      help: 'Seconds between a reply arriving in the mailbox and its ingestion',
      buckets: [5, 15, 30, 60, 120, 300, 600, 1800, 3600],
    }),
  syncs: () =>
    metrics.counter({
      name: 'bf_outreach_syncs_total',
      help: 'Mailbox syncs, by result (ok, error)',
      labelNames: ['provider', 'result'],
    }),
  triage: () =>
    metrics.counter({
      name: 'bf_outreach_triage_total',
      help: 'Triaged replies, by class and whether a person must look',
      labelNames: ['class', 'needs_human'],
    }),
  triageLatency: () =>
    metrics.histogram({
      name: 'bf_outreach_triage_seconds',
      help: 'Seconds from receipt to triage',
      buckets: [1, 2, 5, 10, 20, 60, 300],
    }),
};
