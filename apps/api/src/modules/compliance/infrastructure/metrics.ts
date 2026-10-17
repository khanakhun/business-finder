import { metrics } from '@bf/observability';
import type { ComplianceTelemetry } from '../application/ports.ts';

// Compliance metrics (BF-049): decisions by outcome, jurisdiction and deciding reason, evaluation latency, and
// suppression hits. No business or contact identifiers in labels.

const decisionsTotal = () =>
  metrics.counter({
    name: 'bf_compliance_decisions_total',
    help: 'Compliance decisions, by stage, channel, outcome, jurisdiction and first reason',
    labelNames: ['stage', 'channel', 'decision', 'jurisdiction', 'reason'],
  });

const evaluateSeconds = () =>
  metrics.histogram({
    name: 'bf_compliance_evaluate_seconds',
    help: 'Time to evaluate a compliance decision (inputs, policies, persistence)',
    labelNames: ['stage'],
    buckets: [0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2],
  });

const suppressionHits = () =>
  metrics.counter({
    name: 'bf_compliance_suppression_hits_total',
    help: 'Evaluations blocked by a suppression, by scope',
    labelNames: ['scope'],
  });

export const PROMETHEUS_COMPLIANCE_TELEMETRY: ComplianceTelemetry = {
  decided: ({ stage, channel, decision, jurisdictions, reason, seconds }) => {
    decisionsTotal().inc({ stage, channel, decision, jurisdiction: jurisdictions.join('+'), reason });
    evaluateSeconds().observe({ stage }, seconds);
  },
  suppressed: (scope) => suppressionHits().inc({ scope }),
};
