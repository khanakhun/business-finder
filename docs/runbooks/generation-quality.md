# Generation quality gates: runbook (BF-045)

Every generated version goes through the gates in this order. Schema and facts stop the chain when they fail.

1. Schema.
2. Facts (strict, against the job's registry).
3. Claims (AI).
4. Copy lint.
5. Safe auto-fixes.
6. Accessibility (axe).
7. Performance (Lighthouse).
8. Visual critic (AI).

The decision is one of three:
- **pass:** the version is published as a preview.
- **repair:** the targeted issues go to the engine, at most 12 and at most two repairs.
- **needs_review:** a person decides, with `GET /v1/generation-jobs/:id/quality`, then `POST …/accept` (with a reason;
  refused when schema or facts failed) or `POST …/repair`.

Metrics: `bf_generation_quality_gates_total`, `…_decisions_total`, `…_score`, `…_gate_score`, `…_cost_usd_total` and
`…_platform_issues_total`. Alerts: `infra/observability/alerts/generation-quality.rules.yml`.

## Platform regression

`GenerationQualityPlatformRegression` means issues the platform causes (renderer, fonts, CSS, scripts, layout
landmarks) jumped. No engine can fix them and no repair runs.
1. Read a recent report's `performance` or `a11y` issues tagged `platform: true`
   (`GET /v1/generation-jobs/:id/quality`).
2. Check the last deploys of `@bf/site-blocks` and the runner image (`sitekit audit` renders with them).
3. Reproduce locally:
   - `pnpm runner:build`;
   - run `DOCKER_SANDBOX_IMAGE=bf-agent-runner:dev pnpm --filter @bf/api exec vitest run src/modules/generation/infrastructure/quality/quality.docker.test.ts`;
   - or `sitekit audit --json` on an affected workspace.
4. Fix or roll back the platform change. The affected versions wait in review: accept them or retry once it is fixed.

## Gates erroring

A gate with status `error` could not run: the sandbox was missing or timed out, or the model API failed. The
version goes to review, never through.
- Check the sandbox: the worker's `/health/ready` and the runner image.
- Check the model keys and the provider's status for the AI gates.
- Check `GENERATION_QUALITY_AUDIT_WALL_TIME_SEC` if audits time out on large sites.

## Needs review

Over 30% of versions waiting for a person usually means one of three things:
- an engine regression (compare `…_decisions_total` per engine);
- thresholds too strict for a category (the critic's calibration: `docs/quality/visual-rubric.md`);
- a facts problem upstream (registry or extraction).
