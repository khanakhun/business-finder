# Internal packages (`@bf/*`)

Shared TypeScript libraries live here. Apps (`apps/*`) depend on them with `"@bf/<name>": "workspace:*"`;
packages never depend on apps (enforced by Biome `noRestrictedImports`).

## How packages are consumed: TypeScript source, no build step

Every package's `package.json` `exports` point straight at TypeScript source:

```json
{
  "name": "@bf/example",
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

Consumers compile the source themselves:

| Consumer | How it compiles `@bf/*` source |
|---|---|
| Vitest (all tests) | Vite transforms TypeScript natively |
| `tsc --noEmit` (typecheck) | Resolves `exports` to `.ts` files and checks them |
| Next.js apps (`apps/web`, `apps/sites`) | `transpilePackages: ['@bf/…']` (BF-007, BF-036) |
| NestJS app (`apps/api`) | Its build bundles workspace packages into `dist` for the Docker image (BF-006, BF-025) |

**Why.** No package needs to be built before another can be tested or type-checked, so `typecheck` and `test`
start immediately in every workspace and go-to-definition lands in real source. ADR-0001 calls for source in
development and built output in Docker images; bundling inside each app gives that without maintaining a
separate `dist` per package. Turborepo stays correct through the `transit` task in `turbo.json`, which makes a
dependency's source change invalidate its dependents' cached `typecheck`/`test` results.

**Trade-off.** Node cannot run TypeScript from `node_modules`, so a package can't be `node`-run directly by an
app without a bundler or loader. If a package ever needs to be published or run that way, give it a `build`
script (`tsup`, ESM + `dts`) and add a `default` export condition pointing to `dist`; `turbo run build` already
orders builds by dependency (`^build`).

## Conventions

- Every workspace is ESM (`"type": "module"`): with `NodeNext` resolution a package without it is
  CommonJS, which `verbatimModuleSyntax` rejects.
- Relative imports use the real `.ts` extension (`import { x } from './x.ts'`); `@bf/tsconfig` enables
  `allowImportingTsExtensions`, and Vite, Next.js and Node's type stripping all resolve it.
- `tsconfig.json` extends a preset from `@bf/tsconfig` (`library.json` for packages) and never relaxes it.
- Scripts: `lint` (`biome check .`), `typecheck` (`tsc --noEmit`), `test` (`vitest run --coverage`), plus
  `test:int` only when the package has integration tests (a run with no tests fails on purpose).
- `vitest.config.ts` is one line: `export default defineVitestConfig({ type: 'unit' })` from
  `@bf/testing/vitest-config`. Coverage thresholds (80% lines, 90% branches under `domain/`) come with it and
  apply whenever `--coverage` is passed, so ad-hoc filtered runs (`vitest run -t …`) aren't gated.
- Packages with tests add `@bf/testing`, `vitest` and `@vitest/coverage-v8` as devDependencies (the last two
  are peer dependencies of `@bf/testing`: Vitest loads the coverage provider from the package being tested).
- Test data comes from `faker` exported by `@bf/testing`, which is re-seeded before every test from the test's
  file and name, so failures reproduce exactly.
- Dependency versions shared by several workspaces go in the `catalog:` of `pnpm-workspace.yaml`.

## Known lint gap

`noFloatingPromises` is a Biome nursery rule built on Biome's own type inference rather than the TypeScript
compiler. It catches un-awaited calls to functions whose return type is visibly a `Promise`, but can miss
promises whose type is only known through complex generics or third-party declarations. Review async code
with that in mind. DECISION(BF-001): typescript-eslint's type-checked `no-floating-promises` is not added
yet, to keep a single linter; add it (scoped to that one rule) if reviews find promises the Biome rule missed.

## Packages

| Package | Purpose | Ticket |
|---|---|---|
| `@bf/tsconfig` | TypeScript presets: `base`, `library`, `nestjs`, `nextjs`, `node-script` | BF-001 |
| `@bf/testing` | Vitest config factory, seeded `faker`; DB/container helpers come in BF-003 | BF-001 |
| `@bf/config` | Env schemas per app, `loadEnv` with redacted reports, feature flags, `env:*` CLIs | BF-002 |
