---
description: Implement a Business Finder ticket end-to-end (BF-NNN) following AGENTS.md
argument-hint: BF-NNN
---

You are implementing ticket **$ARGUMENTS** in the Business Finder monorepo.

## 1. Load context (do not write code yet)

1. Read the ticket file: `docs/tickets/$ARGUMENTS-*.md` (use Glob to find it). Read it completely.
2. From its frontmatter, read every ticket in `depends_on` (they are merged — find and reuse their code) and skim every ticket in `blocks` (so you don't paint them into a corner).
3. Read the sections of `docs/ARCHITECTURE.md`, `docs/DOMAIN.md`, the ADRs and the convention docs that the ticket's **References** section lists.
4. Check dependencies are actually merged: verify that the packages/modules they created exist on your branch. If a dependency is missing, stop and report which one.
5. Inspect the existing code you will touch (use Grep/Glob, read only what you need).
6. For any library API you are about to use for the first time in this repo, check its current documentation (Context7 MCP if available, otherwise official docs). Record the version you used.

## 2. Plan

Write a plan of 5–15 bullets: files/modules to create or change, contracts to add, tests to write, and how you will verify. For tickets marked size L, propose a split into stacked PRs and implement part 1 first. Use plan mode if available and wait for approval only if the ticket says `review_plan: true`.

## 3. Implement

- Create the branch `bf-<nnn>-<short-slug>` from up-to-date `main` if you are not already on it.
- Order: contracts → domain + unit tests → application/use cases → infrastructure adapters + integration tests → interface (HTTP/UI) → wiring → docs.
- Follow `docs/conventions/*` exactly. Respect the ticket's *Out of scope* list.
- Keep commits small and conventional: `feat(<scope>): <summary> ($ARGUMENTS)`.

## 4. Verify

Run, and fix until green:
- `pnpm verify`
- `pnpm test:int` if you touched DB, queues or adapters
- `pnpm e2e` if you touched user-facing flows
- `uv run task verify` in `services/intel` if you touched Python
- any ticket-specific verification commands from the ticket

Then run the review subagents on your diff: `code-reviewer`, `security-reviewer`, and `test-engineer`. Address their findings or explain why not.

## 5. Finish

1. Tick the acceptance-criteria checkboxes in the ticket file that are now met; add a short *Implementation notes* section at the end of the ticket (what was built, deviations, versions used).
2. Update `docs/ARCHITECTURE.md` / `docs/DOMAIN.md` / ADRs if anything they describe changed.
3. Push and open a PR titled `$ARGUMENTS: <ticket title>` using `.github/pull_request_template.md`, with `Closes #<issue-number>` (find the number in `docs/tickets/issue-map.json`).
4. Report back: summary, test evidence, decisions & assumptions, follow-ups.
