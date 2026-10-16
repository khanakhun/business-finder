# @bf/sitekit

The site toolbelt of generation agents (BF-042): validate a `site.json`, lint its copy, apply operations, render
it, photograph it and check it is done. One set of tools, three interfaces — a library, the `sitekit` CLI and an
MCP server — plus in-process tools for the Claude Agent SDK.

A **workspace** is the folder the generation builder (BF-040) prepares: `site.json`, `facts.json`,
`assets/assets.json`, `.sitekit.json`, `BRIEF.md`, the block catalog. sitekit never leaves it: paths outside it,
`..` and symlinks that escape are refused, and nothing goes to the network except the loopback server the
screenshots use.

## Agent quick reference

Work in the workspace. Change the site with `sitekit ops apply` (or by editing `site.json`), never invent facts, and
finish when `sitekit check` says **done**.

| Command | What it does |
|---|---|
| `sitekit check` | The definition of done: zero validation errors (strict facts), zero copy errors, every page renders in every locale, home screenshots on mobile and desktop. Exit 0 when done. |
| `sitekit validate` | Schema, rules, facts and limits. Each issue: its path (`pages[0].blocks[2].props.title.fr`), what is wrong, and `fix:` what to do. |
| `sitekit lint-copy [--locale fr] [--fix]` | Placeholders, clichés, unproven superlatives, numbers not in facts, wrong language, French typography, long sentences, duplicates, CTA verbs, SEO lengths, alt texts. `--fix` applies the safe fixes (typography, spaces). |
| `sitekit ops list` | The operations and their JSON Schema. |
| `sitekit ops apply <file.json>` / `--op '<json>'` | Apply operations, all or nothing; `site.json` is written only if the result has no error. |
| `sitekit diff <from.json> [to.json]` | What changed between two specs. |
| `sitekit render [--page id] [--locale fr]` | Static HTML in `.sitekit/render/` (open `_review.html`). |
| `sitekit screenshot --page home [--viewport mobile\|tablet\|desktop] [--full]` | A PNG in `.sitekit/screenshots/`. |
| `sitekit catalog [block]` | The blocks: purpose, variants, guide, JSON Schema. |
| `sitekit facts [--kind phone] [--search …]` | The facts the site may state. |
| `sitekit assets [--role logo\|image]` | The images the site may use. |

Global flags: `--cwd <workspace>` (default `.`), `--json` (one stable envelope: `schemas/cli-output/`), `--quiet`.
Exit codes: `0` ok / done, `1` issues / not done, `2` usage error, `3` internal error. `sitekit help <command>`
shows examples.

Example:

```sh
sitekit check
sitekit ops apply --op '{"op":"updateText","path":["pages",0,"blocks",0,"props","title"],"locale":"fr","value":"Coiffure à Gustavia"}'
sitekit lint-copy --fix
sitekit check   # repeat until "Done"
```

## MCP server

`sitekit mcp` serves the same tools over stdio: `validate_site`, `lint_copy`, `apply_operations`, `diff_site`,
`render_pages`, `screenshot_page` (returns the image), `get_catalog`, `get_facts`, `list_assets`, `check_done`.
Inputs are Zod schemas, read-only tools are annotated, and there is no generic file-write or shell tool.

## Claude Agent SDK

```ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { createSitekitAgentTools, Workspace } from '@bf/sitekit';

const workspace = await Workspace.open('/workspace');
const sitekit = createSdkMcpServer({ name: 'sitekit', tools: createSitekitAgentTools(workspace, tool) });
```

The SDK stays the caller's dependency (the engine, BF-044); the handlers are the MCP server's.

## Configuration

`.sitekit.json` (written by the workspace builder): `locales`, `defaultLocale`, `strictFacts` (default true),
`limits` (pages, blocks per page, spec bytes — tighter only), `lint` (rule id → `error` | `warning` | `off`),
`assetHosts`, `hotlinkHosts`, `ownDomains`.

## Development

- `pnpm sitekit <command> --cwd packages/sitekit/fixtures/workspace-salon` runs the CLI from source (fixtures:
  `workspace-salon`, `workspace-cafe`, `workspace-broken`).
- `pnpm --filter @bf/sitekit build` bundles `dist/sitekit.mjs` (one Node 24 file, the copy rules and the block
  stylesheet and fonts next to it; Playwright stays external).
- `pnpm --filter @bf/sitekit schemas` regenerates `schemas/cli-output/` (a unit test fails when they are stale).
- Copy lint rules are data: `rules/common.yaml`, `rules/fr.yaml`, `rules/en.yaml`.
- Real-browser tests: `SITEKIT_BROWSER=1 pnpm --filter @bf/sitekit exec vitest run src/lib/screenshot.browser.test.ts`
  (needs Playwright's Chromium; the CI sites job runs them).
