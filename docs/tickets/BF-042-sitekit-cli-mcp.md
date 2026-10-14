---
id: BF-042
title: sitekit — agent toolbelt as library, CLI and MCP server (validate, lint, render, screenshot, ops, check)
milestone: M3 Build
epic: generation
type: feature
priority: P0
size: M
depends_on: [BF-033, BF-034]
blocks: [BF-041, BF-043, BF-044, BF-045]
areas: [sites, ai, tooling]
---

# BF-042 — sitekit: agent toolbelt as library, CLI and MCP server (validate, lint, render, screenshot, ops, check)

## Context
Coding agents (Claude Code, Codex, Claude Agent SDK) are powerful when they have **verifiers**: tools that tell them precisely what is wrong and let them look at the result ([ai-engineering §10](../conventions/ai-engineering.md#10-agents-and-tools)). In our design agents edit a `site.json` document, not application code ([ADR-0009](../adr/0009-schema-driven-website-builder.md)). `sitekit` gives them that loop: validate the spec, lint the copy, apply safe operations, render pages, take screenshots they can inspect, and run a final `check` that defines "done" in code. The same functions are used in-process by the blocks engine (BF-041) and the quality gates (BF-045), so every engine is judged by identical rules.

This package depends only on `@bf/site-schema` (BF-033) and `@bf/site-blocks` (BF-034). It can be built in parallel with the generation backend.

## Goal
`@bf/sitekit` provides three interfaces: (1) a typed **library** API; (2) a fast, single-file **CLI** with human and JSON output and stable exit codes; (3) an **MCP server** (stdio), plus a factory of in-process tool definitions for the Claude Agent SDK. All three are confined to a workspace directory and are deterministic.

## Scope
**In scope**
- **Library** (`@bf/sitekit`), pure where possible:
  - `validate(spec, { facts?, strictFacts, config }) → Issue[]`: BF-033 semantic + facts validators, plus a fix hint per issue code ("Shorten hero.title.fr to ≤ 60 chars (currently 74)").
  - `lintCopy(spec, { facts?, locale?, config }) → LintIssue[]`, with rules as data in `rules/<locale>.yaml`:
    - banned clichés per locale;
    - unverifiable superlatives without an `award` fact;
    - literal numbers, phones, emails, prices or years absent from facts;
    - placeholder text (`lorem`, `TODO`, `[…]`, `{{`);
    - wrong-language text inside a locale field (lightweight language detection with confidence threshold);
    - FR typography (non-breaking space before `: ; ! ?` and inside « », apostrophe style);
    - sentence length and reading-level targets;
    - duplicate or near-duplicate sentences across pages;
    - CTA label quality (verb-first);
    - SEO title/description lengths;
    - alt text quality (not "image of", not a filename).

    Each rule has an id, severity and autofix where safe (typography, whitespace).
  - `applyOps(spec, ops) → { spec, inverse, summary }` (BF-033 operations, atomic) and `diff(a, b)`: structural diff, **moved here from the sites module** if BF-035 implemented it there (extract it to `@bf/site-schema/diff`; the sites module re-exports it).
  - `renderSite(spec, { pages?, locales?, outDir })`: static HTML via BF-034 `renderStaticPage` with the shared stylesheet and fonts copied locally, plus an `index.html` linking all pages and locales for review.
  - `screenshot(spec, { page, locale, viewport: 'mobile'|'tablet'|'desktop', fullPage?, outDir })`:
    - Playwright Chromium on the static render served by an ephemeral local HTTP server on 127.0.0.1;
    - all other network requests blocked; fixed fonts; animations disabled; deterministic device settings;
    - returns PNG paths and dimensions.
  - `catalog({ block? })`: the BF-033 catalog (markdown + JSON Schema).
  - `facts({ kind?, search? })` and `assets({ role? })`: workspace readers (`facts.json`, `assets/assets.json`).
  - `check(workspace) → CheckReport` (**definition of done**):
    - `validate` (strict facts) has zero errors;
    - `lintCopy` has zero errors;
    - every page × locale renders;
    - at least one screenshot pair (home mobile/desktop) is produced;
    - spec size limits hold.

    It reports `done: boolean`, blocking items and warnings.
- **CLI** `sitekit` (bundled with tsup/esbuild into `dist/sitekit.mjs`, a Node 24 single file; `bin` entry):
  - Commands: `validate`, `lint-copy` (`--fix` for safe autofixes), `ops list|apply <file>|<op> --json '{…}'`, `diff`, `render`, `screenshot`, `catalog`, `facts`, `assets`, `check`, `mcp`, `--version`, `help <command>` (examples).
  - Global flags: `--cwd <workspace>` (default `.`), `--json` (machine output with a stable schema per command, exported as JSON Schema), `--quiet`.
  - **Exit codes**: `0` success / done, `1` issues found / not done, `2` usage error, `3` internal error. Messages are written for agents: precise path, what is wrong, how to fix, and an example when useful.
  - Performance: cold start for `validate` < 400 ms on the runner image; `check` < 15 s for a 6-page FR/EN site (render + 2 screenshots).
- **MCP server** (`sitekit mcp`, stdio), using the official TypeScript MCP SDK (verify the current package and API):
  - Tools: `validate_site`, `lint_copy`, `apply_operations`, `diff_site`, `render_pages`, `screenshot_page` (returns image content + path), `get_catalog`, `get_facts`, `list_assets`, `check_done`.
  - Zod input schemas; annotations (`readOnlyHint` where applicable); informative errors.
  - **No generic file write or shell tool**: agents modify the site only via `apply_operations` or by editing `site.json` with their own file tools (CLIs), and must pass `check_done`.
- **In-process tools**: `createSitekitAgentTools(workspace)` returns definitions compatible with the Claude Agent SDK `tool()` / `createSdkMcpServer()` (verify the current API), used by the `claude-agent-sdk` engine (BF-044).
- **Workspace confinement**:
  - All paths resolved against `--cwd`; reject absolute paths outside it, `..` traversal and symlinks pointing outside (`realpath` check).
  - Max file sizes (`site.json` ≤ 1 MB).
  - No network access except 127.0.0.1 for the screenshot server; Playwright launched with a blocked network for other hosts.
- **Config** `.sitekit.json` (written by BF-040): locales, `strictFacts`, limits overrides (tighter only), lint rule overrides (severity only), allowed hotlink hosts (BF-038). Zod-validated.
- **Developer usage**: `pnpm sitekit <cmd>` at the repo root against fixture workspaces (`packages/sitekit/fixtures/workspace-*`). README with an agent-oriented quick reference, which is also copied into workspace `AGENTS.md` by BF-044.

**Out of scope**
- Runner image (→ BF-043), engines (→ BF-041/BF-044), quality-gate orchestration, Lighthouse and the visual critic (→ BF-045).

## Requirements
### Functional
- Library, CLI and MCP tools return identical results for the same inputs (shared implementation; parity tests).
- `check` is the single definition of done for sandboxed engines; BF-044 must not accept output unless `check` passes inside **and** outside the sandbox (re-run by the orchestrator).
### Non-functional
- Deterministic outputs (render HTML bytes and screenshots stable across runs on the same image).
- Zero network egress except loopback.

## Design
```
packages/sitekit/
├── src/
│   ├── lib/{validate.ts, lint/{index.ts, rules/*.ts, detectors/*.ts}, ops.ts, diff.ts, render.ts, screenshot.ts,
│   │        catalog.ts, facts.ts, assets.ts, check.ts, workspace.ts (confinement), config.ts}
│   ├── cli/{main.ts, commands/*.ts, output.ts (text/json), exit-codes.ts}
│   ├── mcp/{server.ts, tools.ts}
│   └── agent-sdk/{tools.ts}
├── rules/{fr.yaml, en.yaml, common.yaml}
├── schemas/{cli-output/*.schema.json}
└── fixtures/{workspace-salon, workspace-cafe, workspace-broken-*}
```
- Patterns:
  - Facade (library API over schema, blocks and Playwright).
  - Command (CLI commands and operations).
  - Adapter (MCP and Agent SDK tool wrappers over the library).
  - Rule Engine (data-driven lint rules).
  - Specification (check criteria).

## Implementation plan
1. Library: validate (with fix hints), ops, diff extraction, workspace confinement, config.
2. Copy lint rules engine + FR/EN rule sets + detectors (TDD with a corpus of good and bad strings).
3. Static render-all and deterministic screenshots (Playwright with a blocked network).
4. `check` (definition of done) + report schema.
5. CLI with text/JSON output, exit codes and help/examples; single-file bundle.
6. MCP server + Agent SDK tool factory (verify current SDK APIs); parity tests.
7. README / agent quick reference; fixture workspaces.

## Testing
- **Unit:** each lint rule (positive and negative FR/EN cases), fix hints per issue code, confinement (traversal, symlink escape, absolute paths), config validation.
- **Snapshot:** CLI text and JSON outputs for fixture workspaces; JSON outputs validated against the published schemas.
- **Integration:** render-all and screenshot determinism (hash equality across two runs); network blocked (a page that tries an external fetch gets the request aborted, verified via a Playwright request log).
- **Parity:** library vs CLI vs MCP tool results identical on fixtures (MCP via an in-memory client transport).
- **Performance:** cold-start and `check` timing benchmarks recorded.

## Acceptance criteria
- [ ] Library API: validate (with hints), lintCopy (FR/EN rules as data, safe autofix), ops/diff, render, screenshot, catalog/facts/assets readers, check.
- [ ] CLI with stable JSON schemas, exit codes and agent-friendly messages; single-file bundle.
- [ ] MCP server and Agent SDK tool factory with parity tests.
- [ ] Workspace confinement and no network egress; deterministic render and screenshots.
- [ ] Docs: README + agent quick reference.

## Agent prompt
```text
Implement BF-042 (sitekit: library, CLI and MCP server).

Read first: AGENTS.md, docs/conventions/ai-engineering.md §10 (agents and tools), docs/adr/0009 and 0010,
docs/ARCHITECTURE.md §11 (workspace, toolbelt), BF-033 (validators, operations, catalog), BF-034 (static
renderer). Skim BF-041, BF-043, BF-044 and BF-045 (consumers).

Rules:
- One implementation, three interfaces (library, CLI, MCP); prove parity with tests.
- Messages are written for AI agents: exact path, what is wrong, how to fix, example.
- Confine every file operation to the workspace; no network except loopback for screenshots.
- `check` is the code-defined definition of done; keep its criteria explicit and documented.
- Verify current MCP TypeScript SDK and Claude Agent SDK tool APIs before coding; pin versions.

Verify: pnpm verify; CLI snapshot + parity + determinism suites green; attach benchmark numbers in the PR.
```

## References
- docs/conventions/ai-engineering.md §10 · ADR-0009 · ADR-0010 · BF-033 · BF-034
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk · Claude Agent SDK (TypeScript) custom tools: https://code.claude.com/docs/en/agent-sdk/typescript · Playwright request interception: https://playwright.dev/docs/network
