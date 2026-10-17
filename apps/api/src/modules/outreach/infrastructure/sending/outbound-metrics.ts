import { metrics } from '@bf/observability';

// Outbound pipeline metrics (BF-052); alerts in infra/observability/alerts/outreach.rules.yml.

export const outboundMetrics = {
  messages: () =>
    metrics.counter({
      name: 'bf_outreach_messages_total',
      help: 'Outbound messages reaching a send outcome (sent, failed, blocked), by provider',
      labelNames: ['status', 'provider'],
    }),
  queueTime: () =>
    metrics.histogram({
      name: 'bf_outreach_queue_seconds',
      help: 'Seconds between a message being due and its send attempt',
      buckets: [1, 5, 30, 60, 300, 900, 3600, 4 * 3600, 24 * 3600],
    }),
  latency: () =>
    metrics.histogram({
      name: 'bf_outreach_send_seconds',
      help: 'Provider send call duration',
      labelNames: ['provider'],
      buckets: [0.25, 0.5, 1, 2, 5, 10, 30, 60],
    }),
  reconciliations: () =>
    metrics.counter({
      name: 'bf_outreach_reconciliations_total',
      help: 'Sent-items lookups after an unknown outcome, by result (found, not_found, unknown)',
      labelNames: ['result'],
    }),
  blockedAtSend: () =>
    metrics.counter({
      name: 'bf_outreach_blocked_at_send_total',
      help: 'Messages the send-time compliance check stopped, by reason code',
      labelNames: ['reason'],
    }),
  capacity: () =>
    metrics.counter({
      name: 'bf_outreach_capacity_refusals_total',
      help: 'Send attempts put back in the queue for lack of capacity, by limit',
      labelNames: ['reason'],
    }),
  stuck: () =>
    metrics.gauge({
      name: 'bf_outreach_stuck_sending',
      help: 'Messages still sending more than 10 minutes after their lease ended',
    }),
  approvalsPending: () =>
    metrics.gauge({
      name: 'bf_outreach_approvals_pending',
      help: 'Bulk messages waiting for approval',
    }),
};
