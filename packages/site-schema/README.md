# @bf/site-schema

`SiteSpec` v1: the document every website engine outputs (ADR-0009). The block library (`@bf/site-blocks`, BF-034)
renders it, the editor (BF-037) and chat edits (BF-047) change it, and agents use its JSON Schema as their tool
contract. Browser-safe: no Node APIs outside `src/cli` and the tests (`pnpm check:boundaries` enforces it).

```ts
import { SiteSpecSchema, validateSite, hasErrors } from '@bf/site-schema';

const issues = validateSite(input, {
  assetHosts: ['assets.example'], // our storage, matched exactly
  ownDomains: ['the-business.example'], // its existing website (url actions, booking page)
  mode: 'preview', // the default: noindex and the preview banner must stay on
});
if (hasErrors(issues)) …; // each issue: path, code, severity, an actionable message
```

## What is in it

| Path | |
|---|---|
| `src/spec/` | The schema: `site.ts` (root), `theme.ts`, `contact.ts` (the contact facts every block reads), `layout.ts` (header, footer, navigation), `page.ts`, `cta.ts`, `assets.ts`, `blocks/` (16 block types), `localized.ts` (site locales, ids), `limits.ts` (text lengths: the schema's hard maximum and the recommended range). |
| `src/fonts.ts` | The curated font pairs (`typography.pairId`). |
| `src/validate/` | `semantic.ts` (`validateSite`: what the schema cannot say — preview settings, locales complete, references resolve, one hero per page, images for the variants that show one, contact facts behind every action and block, allowlisted hosts only, no web address or HTML in any text, rich-text subset, WCAG AA contrast with a suggested colour and readable button labels, recommended lengths), `rich-text.ts` (`parseRichText`: the whitelist parser the renderer and editor use too), `contrast.ts`, `hosts.ts`, `issues.ts`. Validation has two phases: schema problems first, then (once they are fixed) the semantic issues. |
| `src/validate/facts.ts` | `FactRegistry` (the facts BF-040 builds) and `validateFacts(spec, registry)`: every named fact exists and has the right kind, contact values, prices, testimonials and team members equal their facts, and phone numbers, e-mails, prices and years written in text must be facts. |
| `src/ops/` | High-level edits (`addPage`, `moveBlock`, `updateBlockProps`, `updateText`, `assignAsset`…): serializable, checked, each returning its inverse; `applyAll` is all or nothing. Used by the editor (BF-037), chat edits (BF-047) and `sitekit ops` (BF-042). |
| `src/migrate/` | `migrateSpec(input)`: upcasters from a stored `schemaVersion` to the current one (v1 is the baseline); `createMigrator` is the harness the next version's tests use. |
| `src/catalog/` | The block catalog (purpose, when to use or avoid, variants with preview paths, good/bad EN/FR examples) and its markdown (props documented from the schema). `pnpm site-schema:catalog` writes `generated/catalog/`. |
| `src/engine-result.ts` | What an engine returns: `{ spec, summary, factsUsed }`. |
| `generated/` | `site-spec.schema.json` and `engine-result.schema.json` (JSON Schema 2020-12, descriptions kept). Regenerate with `pnpm site-schema:jsonschema`; `pnpm site-schema:check` and a unit test fail when they are stale. |
| `fixtures/` | Four fictional sites that validate with no issue (`salon-gustavia`, `cafe-saint-jean`, `hardware-store-lorient`, `villa-agency`) and `broken-*` variants pinned to their issue codes. |

Safety invariants live in the schema and the validator, not in conventions: every contact detail, testimonial,
team member and price names its fact; an action carries only what its kind uses; links go only to the site's own
pages, the business's own domain or a known booking provider; social links only to the network's own profile pages;
images only from our storage; no web address, HTML or hidden characters in text; a preview stays unindexed.
Rich text MUST be rendered from `parseRichText`'s output (its blocks and inlines), never with a markdown library:
CommonMark would turn what the parser refuses (reference links, definitions on the next line) into live links. A `url`
action goes to the business's own domain only; its booking page is a `booking` action (the fact-backed
`contact.bookingUrl`). Consumers still treat a spec as untrusted: BF-035 overwrites the preview settings and resolves assets by id, and the
renderer takes fact values (quotes, prices) from the registry by `factId`.

## Adding a block type

1. **Schema**: add `src/spec/blocks/<group>.ts`'s `block('<type>', [variants…], { props… }, description)` — every
   prop with a `.describe()` written for an agent (what good content looks like, the length target, an example);
   enums over free text; facts by `factId`. Register it in `BLOCK_SCHEMAS` and `BlockSchema` (`blocks/index.ts`).
2. **Rules**: if it needs facts (a contact channel, hours…) or has references, add the requirement to
   `validate/semantic.ts` and a unit test (`validate/semantic.test.ts`); use it in a fixture.
3. **JSON Schema**: `pnpm site-schema:jsonschema` and commit `generated/`.
4. **Catalog**: add its entry to `src/catalog/catalog.ts` (purpose, use/avoid, every variant, good/bad EN/FR); a
   test fails until every variant is described. Run `pnpm site-schema:catalog` and commit `generated/catalog/`.
5. **Component** (BF-034): the React block in `@bf/site-blocks`, for every style.
6. **Editor field** (BF-037): its Puck fields.
7. **Operations**: nothing to do (they are generic over blocks); the property tests cover the new block once a
   fixture uses it.
8. **Tests**: the fixtures still validate; the block renders in every style.
