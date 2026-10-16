---
id: BF-001
title: Monorepo bootstrap and toolchain
milestone: M0 Foundations
epic: foundations
type: infra
priority: P0
size: M
depends_on: []
blocks: [BF-002, BF-004, BF-005, BF-009]
areas: [repo, tooling]
---

# BF-001 — Monorepo bootstrap and toolchain

## Context
The repository currently contains only documentation (`docs/`), agent instructions (`AGENTS.md`, `CLAUDE.md`, `.claude/`) and GitHub templates. Every later ticket assumes a working pnpm + Turborepo monorepo with strict TypeScript, Biome, git hooks and a single `pnpm verify` command. Decisions: [ADR-0001](../adr/0001-monorepo-pnpm-turborepo-uv.md). Layout: [ARCHITECTURE.md §4](../ARCHITECTURE.md#4-monorepo-layout).

## Goal
A clean clone can run `corepack enable && pnpm install && pnpm verify` successfully, with the workspace structure, shared TypeScript presets, linting/formatting, git hooks and Turborepo task graph that every later ticket builds on.

## Scope
**In scope**
- Root `package.json` (private, `packageManager` pinned to the current pnpm 10.x, `engines.node >= 24`), `pnpm-workspace.yaml` (`apps/*`, `packages/*`, `services/*`) with a **pnpm catalog** for shared versions (typescript, @types/node, vitest, zod, react, react-dom, next, @nestjs/*).
- `turbo.json` with tasks: `build`, `dev` (persistent, uncached), `lint`, `typecheck`, `test`, `test:int`, `e2e`, `clean`; correct `dependsOn` (`^build` where needed), `inputs`, `outputs`, and env passthrough (`globalEnv`) for things like `NODE_ENV`.
- `packages/tsconfig` (`@bf/tsconfig`): `base.json`, `library.json`, `nestjs.json`, `nextjs.json`, `node-script.json` — settings from docs/conventions/coding-standards.md §1.
- `packages/testing` (`@bf/testing`) initial version: shared Vitest config factory `defineVitestConfig({ type: 'unit' | 'int' })` (coverage via V8 with thresholds from docs/conventions/testing.md §8, reporters, `passWithNoTests: false`), and a `faker` instance seeded per test file. (BF-003 adds DB helpers.)
- Biome (`biome.json`): formatter (2 spaces, single quotes, trailing commas, line width 110), linter with recommended rules plus `noExplicitAny: error`, `noFloatingPromises` (if available in the current Biome version; otherwise document the gap and add `typescript-eslint`'s rule via a minimal ESLint config for that rule only), `useImportType`, `noDefaultExport` (with overrides for Next.js route files and config files), `noRestrictedImports` patterns preventing `apps/*` cross-imports.
- `lefthook.yml`: `pre-commit` (Biome check --write on staged files), `commit-msg` (commitlint with conventional config and a rule requiring `(BF-\d{3})` in the subject for `feat|fix|refactor|perf` types — warn-level for `chore|docs|ci`).
- Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:int`, `e2e`, `verify` (= `turbo run lint typecheck test`), `format`, `clean`, `prepare` (installs lefthook).
- `.editorconfig`, `.nvmrc` (24), `.npmrc` (`engine-strict=true`, `auto-install-peers=true`), `.vscode/extensions.json` (Biome, Tailwind, Playwright, Python, Ruff) and `.vscode/settings.json` (Biome as default formatter).
- A trivial sample library `packages/_sample` **only during this ticket's verification**, deleted before merge — or keep `@bf/testing` as the package that proves the pipeline (preferred).
- README "Quick start" updated with the exact commands that now work.

**Out of scope**
- Docker/infra (→ BF-002), contracts (→ BF-004), observability (→ BF-005), apps (→ BF-006/BF-007/BF-008), CI workflows (→ BF-009).

## Requirements
### Functional
- `pnpm verify` runs lint + typecheck + unit tests across all workspaces and exits non-zero on any failure.
- `pnpm turbo run build --dry=json` shows a correct task graph.
- Commit hooks install automatically on `pnpm install`.
### Non-functional
- `pnpm install` on a warm store < 30 s; `pnpm verify` on the bootstrap repo < 60 s.
- No global tool installs required besides Node 24 and corepack.

## Design
```
.
├── package.json              # scripts, packageManager, engines, devDeps: turbo, @biomejs/biome, lefthook, @commitlint/*
├── pnpm-workspace.yaml       # packages + catalog:
├── turbo.json
├── biome.json
├── lefthook.yml
├── commitlint.config.mjs
├── .editorconfig / .nvmrc / .npmrc
└── packages/
    ├── tsconfig/             # @bf/tsconfig  (no build; JSON presets exported via package.json "exports")
    └── testing/              # @bf/testing   (vitest config factory; built with tsc or tsup)
```
- Internal packages expose `exports` with `types` + `import` conditions. Libraries compile with `tsup` (ESM, `dts: true`) **or** are consumed as TS source via `exports` → `./src/index.ts` with a `development` condition; pick one approach, document it in `packages/README.md`, and apply consistently (recommendation: source consumption in dev via TS project references + `tsup` build for Docker images).
- Turborepo `test` depends on `^build` only if packages are consumed from `dist`; with source consumption, `test` has no build dependency (faster).

## Implementation plan
1. Verify current stable versions and config syntax (pnpm 10 catalogs, Turborepo 2 `tasks`, Biome 2 config schema, lefthook, commitlint) in official docs.
2. Create root files and `@bf/tsconfig` presets.
3. Create `@bf/testing` with the Vitest config factory and one self-test.
4. Configure Biome, lefthook, commitlint; run `pnpm format` once.
5. Wire scripts and Turborepo tasks; run `pnpm verify`.
6. Update README quick start; document package consumption strategy in `packages/README.md`.

## Testing
- `@bf/testing`: unit test asserting the config factory sets coverage thresholds and `passWithNoTests: false`.
- Manual verification recorded in the PR: clean clone install; `pnpm verify` green; a deliberately mis-formatted file is fixed by the pre-commit hook; `git commit -m "bad"` is rejected; `git commit -m "feat(repo): bootstrap (BF-001)"` accepted.

## Acceptance criteria
- [x] `corepack enable && pnpm install && pnpm verify` succeeds on a clean clone with Node 24.
- [x] Node < 24 is rejected by `engine-strict`.
- [x] Biome formats and lints all TS/JSON files; `noExplicitAny` is an error.
- [x] lefthook pre-commit and commit-msg hooks are installed by `pnpm install` and work as described.
- [x] `@bf/tsconfig` presets exist and are used by `@bf/testing`.
- [x] Turborepo caches `lint`, `typecheck`, `test` (second run is a full cache hit).
- [x] README quick start reflects reality.

## Agent prompt
```text
Implement BF-001 (Monorepo bootstrap and toolchain) for the business-finder repo.

Read first: AGENTS.md, docs/ARCHITECTURE.md §4 and §16, docs/adr/0001-monorepo-pnpm-turborepo-uv.md,
docs/conventions/coding-standards.md §1, docs/conventions/testing.md §8, docs/conventions/git-workflow.md.

Rules for this ticket:
- Look up current stable versions and config formats for pnpm (catalogs), Turborepo 2, Biome, lefthook and
  commitlint in their official docs (Context7 if available). Do not rely on memory for config keys.
- Only create the root tooling, @bf/tsconfig and @bf/testing. Other packages/apps belong to later tickets.
- Prefer zero-config defaults; every non-default setting needs a one-line comment explaining why.
- Keep TypeScript settings exactly as listed in coding-standards.md §1.

Deliver: root config files, the two packages, scripts, hooks, updated README quick start, packages/README.md
describing how internal packages are consumed (source vs dist) and why.

Verify: from a clean clone (`git clean -xfd`), run `corepack enable && pnpm install && pnpm verify` twice
(second run must be a Turborepo cache hit). Demonstrate the hooks in the PR description.
Report the tool versions you pinned.
```

## References
- docs/ARCHITECTURE.md §4, §16 · ADR-0001
- pnpm catalogs: https://pnpm.io/catalogs · Turborepo: https://turborepo.com/docs · Biome: https://biomejs.dev/ · lefthook: https://lefthook.dev/

## Implementation notes
- **Pinned versions** (pnpm catalog in `pnpm-workspace.yaml`): pnpm 10.34.7 (`packageManager`), Turborepo 2.11.8,
  Biome 2.5.15, lefthook 2.2.2, commitlint 21.2.3, TypeScript 6.0.3, @types/node 24.19.2, Vitest 5.0.4,
  @faker-js/faker 10.6.0. Catalog also pins zod 4.6.7, react/react-dom 19.3.1, next 16.4.1, @nestjs/* 12.1.3 for later tickets.
- **TypeScript 6, not 7.** TS 7.0 (native port) is the npm `latest` but exposes only an `unstable/*` compiler
  API; tsup dts, the NestJS CLI and typescript-eslint need the stable one. `DECISION(BF-001)` in the catalog.
- **Package consumption: TypeScript source, no per-package build** (documented in `packages/README.md`).
  `exports` point to `src/*.ts`; apps compile/bundle them. A `transit` task in `turbo.json` makes dependency
  source changes invalidate dependents' `typecheck`/`test` cache without forcing a build.
- **Biome config is `biome.jsonc`**, not `biome.json`: Biome rejects comments in `.json`, and the ticket asks for
  a comment on every non-default setting. Biome 2.5 deprecates `"recommended": true` in favour of `"preset": "recommended"`.
- **`noFloatingPromises`** is available (Biome nursery, Biome's own type inference) and enabled as an error.
  Gap vs. typescript-eslint documented in `packages/README.md`; no ESLint added.
- **Root-level files** are linted by a `//#lint:root` task that every package `lint` depends on, so `turbo run lint`
  covers configs and `scripts/` too. `pnpm format` reformatted `scripts/tickets/*.mjs` once (whitespace only).
- **Faker seeding**: re-seeded before *every test* from `<relative file path>::<full test name>` (still derived
  from the file, but order- and filter-independent). Use `faker` from `@bf/testing`.
- **pnpm build scripts**: `allowBuilds: { lefthook: false }` — the binary ships via optional platform packages and
  `prepare` installs hooks; pnpm 10's default blocks all other dependency scripts.
- `.npmrc` keeps `engine-strict` / `auto-install-peers` as the ticket specifies; Node 22 fails `pnpm install`
  with `ERR_PNPM_UNSUPPORTED_ENGINE`.
