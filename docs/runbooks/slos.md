# Service level objectives (BF-061)

Four SLOs over rolling 30 days. Each has an error budget, recorded error ratios (`slo:*` rules in
`infra/observability/alerts/slo.rules.yml`) and multi-window burn-rate alerts (Google SRE workbook): **page** when
the budget burns 14.4× too fast over both 1 h and 5 min (2% of the month's budget in an hour), **ticket** when 6×
over both 6 h and 30 min. Dashboard: *SLOs and error budgets*.

| SLO | Objective | Budget | SLI (source) | Alerts |
|---|---|---|---|---|
| Renderer availability | 99.9% monthly | 0.1% | failed probes of the canary preview (blackbox, every 30 s, through DNS and TLS) | RendererErrorBudgetBurnFast / Slow |
| Renderer latency | P95 < 300 ms | — | probe duration of the canary preview, P95 over 1 h | RendererSlow (30 min) |
| API availability | 99.5% monthly | 0.5% | 5xx responses / all (`bf_http_requests_total{job="api"}`) | ApiErrorBudgetBurnFast / Slow |
| Outbound send pipeline | 99% of due messages attempted within 10 min of their slot | 1% | `bf_outreach_queue_seconds` (due → attempt), share above 600 s | SendPipelineSlow (6× over 6 h and 30 min) |
| Generation | 95% of jobs settle within 30 min of creation | 5% | `bf_generation_job_seconds`, share above 1 800 s | GenerationSlow (over 3 d and 6 h) |

**Why synthetic for the renderer.** The renderer (apps/sites) exports no metrics of its own, and Caddy's request
metrics per host would make one series set per preview hostname. A probe of one canary preview (`CANARY_URL`: a
preview the agency keeps published, unlisted) measures what a prospect sees, end to end. The API, worker and intel
use their own request metrics.

**Error budget policy.** When a budget is spent for the month: feature releases pause for that surface (fixes,
rollbacks and reliability work only) until the 30-day window recovers; the incident notes say what consumed it.
Generation and the send pipeline are throughput SLOs: a spent budget means capacity (production.md §5) before
features.

**Uptime probes from outside.** The in-host blackbox probes cannot see the host itself fail. Configure an external
uptime service (any hosted checker, or a small probe on another provider) for, every minute:
`https://app.<domain>/health/ready`, `https://api.<domain>/health/ready`, the canary preview, and
`https://u.<domain>/u/probe` (a 4xx page is up; a 5xx or timeout is down), alerting the same e-mail and chat as
Alertmanager.
