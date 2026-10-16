# @bf/site-schema

`SiteSpec` v1: the document every website engine outputs (ADR-0009). The block library (`@bf/site-blocks`, BF-034)
renders it, the editor (BF-037) and chat edits (BF-047) change it, and agents use its JSON Schema as their tool
contract. Browser-safe: no Node APIs outside `src/cli` and the tests (`pnpm check:boundaries` enforces it).

```ts
import { SiteSpecSchema, validateSite, hasErrors } from '@bf/site-schema';

const issues = validateSite(input, { assetHosts: ['assets.example'], ownDomains: ['the-business.example'] });
if (hasErrors(issues)) …; // each issue: path, code, severity, an actionable message
```

## What is in it

| Path | |
|---|---|
| `src/spec/` | The schema: `site.ts` (root), `theme.ts`, `contact.ts` (the contact facts every block reads), `layout.ts` (header, footer, navigation), `page.ts`, `cta.ts`, `assets.ts`, `blocks/` (16 block types), `localized.ts` (site locales, ids), `limits.ts` (text lengths: the schema's hard maximum and the recommended range). |
| `src/fonts.ts` | The curated font pairs (`typography.pairId`). |
| `src/validate/` | `semantic.ts` (`validateSite`: what the schema cannot say — locales complete, references resolve, one hero per page, contact facts behind every action and block, allowlisted hosts only, no links in free text, rich-text subset, WCAG AA contrast with a suggested colour, recommended lengths), `contrast.ts`, `hosts.ts`, `issues.ts`. |
| `src/engine-result.ts` | What an engine returns: `{ spec, summary, factsUsed }`. |
| `generated/` | `site-spec.schema.json` and `engine-result.schema.json` (JSON Schema 2020-12, descriptions kept). Regenerate with `pnpm site-schema:jsonschema`; `pnpm site-schema:check` and a unit test fail when they are stale. |
| `fixtures/` | Four fictional sites that validate with no issue (`salon-gustavia`, `cafe-saint-jean`, `hardware-store-lorient`, `villa-agency`) and `broken-*` variants pinned to their issue codes. |

Safety invariants live in the schema and the validator, not in conventions: testimonials and team members need a
fact, prices are price facts, actions resolve from the contact facts, links go only to the site's own pages, the
business's own domain or a known booking provider, images only from our storage, no raw HTML.

## Adding a block type

1. **Schema**: add `src/spec/blocks/<group>.ts`'s `block('<type>', [variants…], { props… }, description)` — every
   prop with a `.describe()` written for an agent (what good content looks like, the length target, an example);
   enums over free text; facts by `factId`. Register it in `BLOCK_SCHEMAS` and `BlockSchema` (`blocks/index.ts`).
2. **Rules**: if it needs facts (a contact channel, hours…) or has references, add the requirement to
   `validate/semantic.ts` and a unit test (`validate/semantic.test.ts`); use it in a fixture.
3. **JSON Schema**: `pnpm site-schema:jsonschema` and commit `generated/`.
4. **Catalog** (BF-033 part 2): describe when to use it, its variants and good/bad examples.
5. **Component** (BF-034): the React block in `@bf/site-blocks`, for every style.
6. **Editor field** (BF-037): its Puck fields.
7. **Tests**: the fixtures still validate; the block renders in every style.
