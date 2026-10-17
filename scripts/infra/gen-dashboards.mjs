#!/usr/bin/env node
// Grafana dashboards as code (BF-061): each dashboard is a list of rows of panels (title, PromQL, unit), written to
// infra/observability/dashboards/<uid>.json, which Grafana provisions read-only. Change a dashboard here, then
// `node scripts/infra/gen-dashboards.mjs`. The metric names are the applications' (docs/runbooks/slos.md lists them).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'infra/observability/dashboards';
const PROM = { type: 'prometheus', uid: 'prometheus' };

/** A time series panel; `targets` are [PromQL, legend] pairs. */
const ts = (title, targets, unit = 'short', extra = {}) => ({
  kind: 'timeseries',
  title,
  targets,
  unit,
  ...extra,
});
/** A single-value panel with thresholds (green → amber → red). */
const stat = (title, expr, unit = 'short', steps = []) => ({
  kind: 'stat',
  title,
  targets: [[expr, '']],
  unit,
  steps,
});

const DASHBOARDS = [
  {
    uid: 'bf-slos',
    title: 'SLOs and error budgets',
    rows: [
      [
        stat(
          'API availability (30 d)',
          '1 - avg_over_time(slo:api_errors:ratio_rate1h[30d])',
          'percentunit',
          [
            [0, 'red'],
            [0.995, 'green'],
          ],
        ),
        stat(
          'Renderer availability (30 d)',
          '1 - avg_over_time(slo:renderer_errors:ratio_rate1h[30d])',
          'percentunit',
          [
            [0, 'red'],
            [0.999, 'green'],
          ],
        ),
        stat('Renderer P95 (1 h)', 'slo:renderer_latency_seconds:p95_1h', 's', [
          [0, 'green'],
          [0.3, 'red'],
        ]),
        stat('Sends late (6 h)', 'slo:send_late:ratio_rate6h', 'percentunit', [
          [0, 'green'],
          [0.01, 'red'],
        ]),
        stat('Generation over 30 min (3 d)', 'slo:generation_slow:ratio_rate3d', 'percentunit', [
          [0, 'green'],
          [0.05, 'red'],
        ]),
      ],
      [
        ts(
          'API error ratio',
          [
            ['slo:api_errors:ratio_rate5m', '5m'],
            ['slo:api_errors:ratio_rate1h', '1h'],
            ['0.005', 'budget'],
          ],
          'percentunit',
        ),
        ts(
          'Renderer error ratio (canary probe)',
          [
            ['slo:renderer_errors:ratio_rate5m', '5m'],
            ['slo:renderer_errors:ratio_rate1h', '1h'],
            ['0.001', 'budget'],
          ],
          'percentunit',
        ),
      ],
    ],
  },
  {
    uid: 'bf-api',
    title: 'API (RED)',
    rows: [
      [
        ts(
          'Requests by status',
          [['sum by (status) (rate(bf_http_requests_total{job="api"}[5m]))', '{{status}}']],
          'reqps',
        ),
        ts(
          '5xx ratio',
          [
            [
              'sum(rate(bf_http_requests_total{job="api",status="5xx"}[5m])) / clamp_min(sum(rate(bf_http_requests_total{job="api"}[5m])), 1e-9)',
              '5xx',
            ],
          ],
          'percentunit',
        ),
        ts(
          'Latency',
          [
            [
              'histogram_quantile(0.5, sum by (le) (rate(bf_http_request_duration_seconds_bucket{job="api"}[5m])))',
              'p50',
            ],
            [
              'histogram_quantile(0.95, sum by (le) (rate(bf_http_request_duration_seconds_bucket{job="api"}[5m])))',
              'p95',
            ],
            [
              'histogram_quantile(0.99, sum by (le) (rate(bf_http_request_duration_seconds_bucket{job="api"}[5m])))',
              'p99',
            ],
          ],
          's',
        ),
      ],
      [
        ts(
          'Slowest routes (p95)',
          [
            [
              'topk(10, histogram_quantile(0.95, sum by (le, route) (rate(bf_http_request_duration_seconds_bucket{job="api"}[15m]))))',
              '{{route}}',
            ],
          ],
          's',
        ),
        ts(
          'Routes returning 5xx',
          [
            [
              'topk(10, sum by (route) (rate(bf_http_requests_total{job="api",status="5xx"}[15m])))',
              '{{route}}',
            ],
          ],
          'reqps',
        ),
        ts('Process', [
          ['sum by (job) (process_resident_memory_bytes{job=~"api|worker"})', '{{job}} memory'],
          ['sum by (job) (rate(process_cpu_seconds_total{job=~"api|worker"}[5m]))', '{{job}} cpu'],
        ]),
      ],
    ],
  },
  {
    uid: 'bf-queues',
    title: 'Queues and the outbox',
    rows: [
      [
        ts('Waiting jobs', [['sum by (queue) (bf_queue_jobs{state=~"waiting|prioritized"})', '{{queue}}']]),
        ts(
          'Oldest waiting job',
          [['max by (queue) (bf_queue_oldest_waiting_age_seconds)', '{{queue}}']],
          's',
        ),
        ts('Failed jobs (stored)', [['sum by (queue) (bf_queue_jobs{state="failed"})', '{{queue}}']]),
      ],
      [
        ts(
          'Jobs handled by outcome',
          [['sum by (outcome) (rate(bf_jobs_processed_total[5m]))', '{{outcome}}']],
          'ops',
        ),
        ts(
          'Job duration p95',
          [
            [
              'histogram_quantile(0.95, sum by (le, queue) (rate(bf_job_duration_seconds_bucket[15m])))',
              '{{queue}}',
            ],
          ],
          's',
        ),
        ts('Outbox', [
          ['max(bf_outbox_pending_events)', 'pending events'],
          [
            'histogram_quantile(0.95, sum by (le) (rate(bf_outbox_dispatch_lag_seconds_bucket[5m])))',
            'dispatch lag p95 (s)',
          ],
        ]),
      ],
    ],
  },
  {
    uid: 'bf-generation',
    title: 'Generation and sandboxes',
    rows: [
      [
        ts('Jobs by engine and outcome', [
          ['sum by (engine, outcome) (increase(bf_generation_jobs_total[1h]))', '{{engine}} {{outcome}}'],
        ]),
        ts(
          'Job duration p50 / p95',
          [
            ['histogram_quantile(0.5, sum by (le) (rate(bf_generation_job_seconds_bucket[1h])))', 'p50'],
            ['histogram_quantile(0.95, sum by (le) (rate(bf_generation_job_seconds_bucket[1h])))', 'p95'],
          ],
          's',
        ),
        ts('Sandboxes', [
          ['max(bf_generation_active_sandboxes)', 'held'],
          ['sum(rate(bf_generation_lease_waits_total[5m])) * 60', 'lease waits / min'],
        ]),
      ],
      [
        ts(
          'Cost per job p50 / p95',
          [
            ['histogram_quantile(0.5, sum by (le) (rate(bf_generation_job_cost_usd_bucket[6h])))', 'p50'],
            ['histogram_quantile(0.95, sum by (le) (rate(bf_generation_job_cost_usd_bucket[6h])))', 'p95'],
          ],
          'currencyUSD',
        ),
        ts('Quality decisions', [
          ['sum by (decision) (increase(bf_generation_quality_decisions_total[1h]))', '{{decision}}'],
        ]),
        ts('Sandbox runs by outcome', [
          ['sum by (outcome) (increase(bf_sandbox_runs_total[1h]))', '{{outcome}}'],
        ]),
      ],
    ],
  },
  {
    uid: 'bf-outreach',
    title: 'Outreach',
    rows: [
      [
        ts('Messages by status', [
          ['sum by (status) (increase(bf_outreach_messages_total[1h]))', '{{status}}'],
        ]),
        ts(
          'Due → attempt p95',
          [['histogram_quantile(0.95, sum by (le) (rate(bf_outreach_queue_seconds_bucket[1h])))', 'p95']],
          's',
        ),
        stat('Kill switch', 'max(bf_outreach_kill_switch_active)', 'short', [
          [0, 'green'],
          [1, 'red'],
        ]),
      ],
      [
        ts(
          'Mailbox bounce rate (last 50 sends)',
          [['bf_outreach_mailbox_bounce_rate', '{{mailbox}}']],
          'percentunit',
        ),
        ts('Automatic pauses', [
          ['sum by (reason) (increase(bf_outreach_mailbox_paused_total[1d]))', '{{reason}}'],
        ]),
        ts('Compliance decisions', [
          ['sum by (decision) (increase(bf_compliance_decisions_total[1h]))', '{{decision}}'],
        ]),
      ],
      [
        ts('Replies triaged', [['sum by (class) (increase(bf_outreach_triage_total[1h]))', '{{class}}']]),
        ts('Mailbox syncs', [
          ['sum by (provider, result) (increase(bf_outreach_syncs_total[1h]))', '{{provider}} {{result}}'],
        ]),
        stat('Sends without a decision', 'max(bf_compliance_sends_without_decision)', 'short', [
          [0, 'green'],
          [1, 'red'],
        ]),
      ],
    ],
  },
  {
    uid: 'bf-renderer',
    title: 'Renderer and public surfaces',
    rows: [
      [
        ts('Probe success', [['probe_success{job="blackbox-http"}', '{{probe}}']]),
        ts('Probe duration', [['probe_duration_seconds{job="blackbox-http"}', '{{probe}}']], 's'),
        ts(
          'Certificate expiry',
          [['probe_ssl_earliest_cert_expiry{job="blackbox-http"} - time()', '{{probe}}']],
          's',
        ),
      ],
      [
        ts(
          'Edge requests by code (Caddy)',
          [['sum by (code) (rate(caddy_http_requests_total[5m]))', '{{code}}']],
          'reqps',
        ),
        ts(
          'Edge latency p95 (Caddy)',
          [
            [
              'histogram_quantile(0.95, sum by (le) (rate(caddy_http_request_duration_seconds_bucket[5m])))',
              'p95',
            ],
          ],
          's',
        ),
        ts(
          '4xx / 5xx at the edge',
          [
            ['sum(rate(caddy_http_requests_total{code=~"4.."}[5m]))', '4xx'],
            ['sum(rate(caddy_http_requests_total{code=~"5.."}[5m]))', '5xx'],
          ],
          'reqps',
        ),
      ],
    ],
  },
  {
    uid: 'bf-postgres',
    title: 'Postgres and backups',
    rows: [
      [
        ts('Connections', [['sum by (state) (pg_stat_activity_count)', '{{state}}']]),
        ts(
          'Transactions',
          [
            ['sum(rate(pg_stat_database_xact_commit[5m]))', 'commits'],
            ['sum(rate(pg_stat_database_xact_rollback[5m]))', 'rollbacks'],
          ],
          'ops',
        ),
        ts('Database size', [['sum by (datname) (pg_database_size_bytes)', '{{datname}}']], 'bytes'),
      ],
      [
        stat(
          'Last full backup',
          'time() - max(bf_backup_last_success_timestamp_seconds{repo="1",type="full"})',
          's',
          [
            [0, 'green'],
            [93600, 'red'],
          ],
        ),
        stat('WAL waiting in the spool', 'max(bf_wal_spool_files)', 'short', [
          [0, 'green'],
          [10, 'red'],
        ]),
        stat('Last restore drill', 'time() - max(bf_restore_drill_last_success_timestamp_seconds)', 's', [
          [0, 'green'],
          [3024000, 'red'],
        ]),
        stat('Drill RTO', 'max(bf_restore_drill_rto_seconds)', 's', [
          [0, 'green'],
          [7200, 'red'],
        ]),
      ],
    ],
  },
  {
    uid: 'bf-host',
    title: 'Host and containers',
    rows: [
      [
        ts('CPU', [['1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))', 'busy']], 'percentunit'),
        ts('Memory available', [['node_memory_MemAvailable_bytes', 'available']], 'bytes'),
        ts(
          'Disk used',
          [
            [
              '1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"}',
              '{{mountpoint}}',
            ],
          ],
          'percentunit',
        ),
      ],
      [
        ts('Container CPU', [
          [
            'sum by (container_label_com_docker_compose_service) (rate(container_cpu_usage_seconds_total[5m]))',
            '{{container_label_com_docker_compose_service}}',
          ],
        ]),
        ts(
          'Container memory',
          [
            [
              'sum by (container_label_com_docker_compose_service) (container_memory_working_set_bytes)',
              '{{container_label_com_docker_compose_service}}',
            ],
          ],
          'bytes',
        ),
        ts('Load', [['node_load5', 'load5']]),
      ],
    ],
  },
  {
    uid: 'bf-ai-costs',
    title: 'AI spend',
    rows: [
      [
        ts(
          'Spend this month per workspace',
          [
            ['bf_ai_spend_month_usd', '{{organization}}'],
            ['max(bf_ai_budget_month_usd{level="hard"})', 'hard budget'],
            ['max(bf_ai_budget_month_usd{level="soft"})', 'soft budget'],
          ],
          'currencyUSD',
        ),
        ts(
          'Generation cost (per hour)',
          [['sum(increase(bf_generation_job_cost_usd_sum[1h]))', 'generation']],
          'currencyUSD',
        ),
        ts(
          'Quality gates cost (per hour)',
          [['sum by (gate) (increase(bf_generation_quality_cost_usd_total[1h]))', '{{gate}}']],
          'currencyUSD',
        ),
      ],
    ],
  },
];

function panel(def, id, x, y, w, h) {
  const base = {
    id,
    title: def.title,
    type: def.kind,
    datasource: PROM,
    gridPos: { x, y, w, h },
    targets: def.targets.map(([expr, legend], index) => ({
      refId: String.fromCharCode(65 + index),
      datasource: PROM,
      expr,
      legendFormat: legend,
    })),
    fieldConfig: { defaults: { unit: def.unit }, overrides: [] },
  };
  if (def.kind === 'stat') {
    base.fieldConfig.defaults.thresholds = {
      mode: 'absolute',
      steps: (def.steps.length ? def.steps : [[0, 'green']]).map(([value, color], index) => ({
        color,
        value: index === 0 ? null : value,
      })),
    };
    base.options = { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'background', graphMode: 'none' };
  } else {
    base.options = { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } };
  }
  return base;
}

function dashboard(def) {
  const panels = [];
  let y = 0;
  let id = 1;
  for (const row of def.rows) {
    const height = row.every((item) => item.kind === 'stat') ? 5 : 8;
    const width = Math.floor(24 / row.length);
    row.forEach((item, index) => {
      panels.push(panel(item, id++, index * width, y, width, height));
    });
    y += height;
  }
  return {
    uid: def.uid,
    title: def.title,
    tags: ['business-finder'],
    timezone: 'utc',
    schemaVersion: 39,
    version: 1,
    editable: false,
    refresh: '1m',
    time: { from: 'now-24h', to: 'now' },
    panels,
  };
}

mkdirSync(OUT, { recursive: true });
for (const def of DASHBOARDS) {
  writeFileSync(join(OUT, `${def.uid}.json`), `${JSON.stringify(dashboard(def), null, 2)}\n`);
}
console.log(`Wrote ${DASHBOARDS.length} dashboards to ${OUT}`);
