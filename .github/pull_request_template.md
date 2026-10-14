## BF-NNN: <ticket title>

Closes #<issue>

### Plan
<!-- The 5–15 bullet plan you followed. -->

### What changed
<!-- Modules/packages touched, contracts added, migrations, UI. -->

### Decisions & assumptions
<!-- Anything the ticket did not specify; link DECISION(BF-NNN) comments. -->

### Test evidence
<!-- Paste the summary of `pnpm verify` (and test:int / e2e / uv run task verify where relevant). Screenshots for UI. -->

### Migrations
- [ ] None
- [ ] Forward-only, safe on populated tables (indexes CONCURRENTLY in their own migration)

### Checklist
- [ ] Acceptance criteria met (ticket checkboxes ticked)
- [ ] Contracts in `@bf/contracts`; generated clients/models up to date
- [ ] Tests: happy path, edge cases, failure paths, authz, idempotency
- [ ] Observability: logs/spans/metrics for new flows
- [ ] Security: `security-reviewer` run, findings addressed
- [ ] Docs/ADRs updated

### Follow-ups
<!-- Out-of-scope work discovered; propose new tickets. -->
