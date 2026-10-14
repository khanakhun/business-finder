---
id: BF-NNN
title: Short imperative title
milestone: M1 Find & List
epic: business-graph
type: feature
priority: P0
size: M
depends_on: []
blocks: []
areas: [api, db]
---

# BF-NNN — Short imperative title

## Context
Why this exists, what already exists (link dependency tickets and the modules they created), and the concepts involved (link DOMAIN.md terms).

## Goal
One to three sentences describing the outcome when this ticket is done.

## Scope
**In scope**
- …

**Out of scope**
- … (→ BF-0xx)

## Requirements
### Functional
- FR: …
### Non-functional
- Performance / security / observability / i18n requirements specific to this ticket.

## Design
Data model (tables, columns, indexes), contracts (Zod schemas), APIs (routes, permissions), module layout (files), patterns to apply and why, state machines, error codes, sequence of operations, configuration and feature flags.

## Implementation plan
1. Contracts …
2. Domain + unit tests …
3. Application/use cases …
4. Infrastructure + integration tests …
5. Interface (HTTP/UI) …
6. Docs …

## Testing
Explicit list of tests to write (unit, integration, contract, e2e), fixtures needed, and commands to run.

## Acceptance criteria
- [ ] Given … when … then …
- [ ] `pnpm verify` green; integration/e2e suites relevant to this ticket green.

## Agent prompt
```text
Ticket-specific instructions for Claude Code / Codex. The generic workflow is in AGENTS.md §5 and /ticket.
```

## References
- docs/ARCHITECTURE.md §…
- ADR-00xx …
- External docs …
