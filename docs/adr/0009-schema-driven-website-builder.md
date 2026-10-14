# ADR-0009: Schema-driven website builder (SiteSpec + block library + Puck)

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-033…BF-038, BF-047

## Context

We need to create 2–6 page bilingual websites for local businesses automatically, host them on our own domain instantly, let humans tweak them visually (Wix-like) or by chat (Lovable-like), share a link in emails, and later hand them over to paying clients. Generation is done by AI engines including coding agents (Claude Code, Codex). Sites must be fast, accessible, consistent in quality and safe to host on our domain.

Options range from letting coding agents write free-form apps (a repo per site) to a fully constrained document model.

## Decision

- A site is a **document**: `SiteSpec` (JSON) validated by `@bf/site-schema` (Zod), stored as immutable **versions** in Postgres.
- Rendering uses our own **block library** `@bf/site-blocks` (React Server Components + Tailwind + theme tokens) in a **multi-tenant Next.js renderer** (`apps/sites`) on `<slug>.<sites-domain>`.
- **Puck** (open-source, MIT, React) is the **visual editor**, configured with the same block components; a thin adapter converts SiteSpec ⇄ Puck data. Puck's hosted AI product is not required — generation uses our own engines.
- **All engines output a SiteSpec.** Coding agents operate on `site.json` in a sandbox workspace using `sitekit` tools (validate/render/screenshot), not on application code. This makes their output safe to host, editable in Puck, comparable across engines and checkable by quality gates.
- Extensibility: new visual capability = new block type (code-reviewed, tested) — not per-site code. A future "custom block" escape hatch (scoped CSS or sandboxed HTML) may be added behind a flag with strict sanitization.
- Previews are `noindex`, carry a "concept preview" banner with the agency name and expire by default.

## Alternatives considered

| Option | Why not |
|---|---|
| Free-form code per site (agent writes a Next.js/Astro app, we build & host static output) | Max flexibility, but slow, expensive, inconsistent quality, hard to edit visually, and serving arbitrary agent-written JS on our domain is a security liability. Kept as a possible future engine output type, not the default. |
| Payload CMS (Next.js-native) | Excellent CMS (auth, versions, blocks field, multi-tenant plugin), but duplicates our backend/auth, and its block editing is form-based rather than WYSIWYG; better suited later for client-managed content after handover. |
| Directus | Headless CMS with its own data model and admin; another stateful system to integrate. |
| GrapesJS | Mature HTML builder, but HTML/CSS-centric output is harder to keep consistent and type-safe than React blocks + schema. |
| Builder.io / Webflow / Wix APIs | Commercial lock-in, per-site costs, limited control over generation. |

## Consequences

- Positive: instant publish, consistent quality and performance, safe hosting, visual + chat editing, engine-agnostic comparisons, easy versioning/rollback.
- Positive: SiteSpec JSON Schema doubles as a precise tool contract for agents (`--json-schema` / `--output-schema`).
- Negative: design range is bounded by the block library — mitigated by multiple style families, variants per block, theme tokens and adding blocks over time.
- Negative: we maintain the block library and the Puck field mapping.

## References

- Puck (MIT core): https://puckeditor.com/ — Puck AI (hosted, paid) launched July 2026; not required here.
- Payload CMS: https://payloadcms.com/
