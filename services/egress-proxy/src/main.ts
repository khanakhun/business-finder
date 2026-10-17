import {
  createEgressProxy,
  createMetricsServer,
  EgressMetrics,
  type EgressProfile,
  PROFILES,
} from './proxy.ts';

// The egress proxy's process (BF-043): EGRESS_PROFILE (models | models_assets) plus EGRESS_ALLOW_EXTRA (comma list
// of hostnames or *.suffix patterns); the proxy on EGRESS_PORT (4750), metrics and health on EGRESS_METRICS_PORT.

const profile = (process.env.EGRESS_PROFILE ?? 'models') as EgressProfile;
if (!(profile in PROFILES)) {
  console.error(`EGRESS_PROFILE must be one of ${Object.keys(PROFILES).join(', ')}`);
  process.exit(2);
}
const extra = (process.env.EGRESS_ALLOW_EXTRA ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);
const allow = [...PROFILES[profile], ...extra];
const metrics = new EgressMetrics();
const port = Number(process.env.EGRESS_PORT ?? 4750);
const metricsPort = Number(process.env.EGRESS_METRICS_PORT ?? 9465);
createEgressProxy({ allow }, metrics).listen(port, () =>
  console.log(JSON.stringify({ msg: 'egress proxy started', port, profile, allow })),
);
createMetricsServer(metrics).listen(metricsPort);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => process.exit(0));
