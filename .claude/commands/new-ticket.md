---
description: Draft a new ticket in docs/tickets using the standard template
argument-hint: <short description of the work>
---

Create a new ticket for: **$ARGUMENTS**

1. Read `docs/tickets/_TEMPLATE.md` and `docs/tickets/README.md` (to pick the next free `BF-NNN` id and see existing epics/milestones).
2. Read the docs and existing tickets related to the work so the new ticket references real modules, contracts and dependencies.
3. Write `docs/tickets/BF-NNN-<slug>.md` following the template exactly: frontmatter, Context, Goal, Scope (in/out), Requirements, Design, Implementation plan, Testing, Acceptance criteria, Agent prompt, References.
4. Set only `depends_on` by hand (and add the new id to the `depends_on` of tickets that must now wait for it). Then run `node scripts/tickets/graph.mjs --write`: it validates the graph (unknown ids, cycles, milestone order), recomputes every `blocks` list and regenerates the index, waves and dependency graph in `docs/tickets/README.md`. It must report 0 errors.
5. Do not create the GitHub issue yourself; tell the user to run `node scripts/tickets/sync-issues.mjs` (or run it if they asked you to).
