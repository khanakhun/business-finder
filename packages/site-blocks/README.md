# @bf/site-blocks

The block library every generated site renders with (BF-034, ADR-0009): one React component per block type and
variant of the SiteSpec (`@bf/site-schema`), five style families, curated self-hosted fonts and a static renderer.
The same components render in the site renderer (`apps/sites`, BF-036), the editor canvas (BF-037) and the agents'
`sitekit render` (BF-042).

## Use

```tsx
import { SitePage } from '@bf/site-blocks';
import '@bf/site-blocks/styles.css'; // built: pnpm --filter @bf/site-blocks build

<SitePage
  spec={spec}
  page="home"                       // a page id or the page
  locale="fr"
  assetsResolver={(asset) => ({ src: cdnUrl(asset), srcSet: cdnSrcSet(asset) })}
  imageComponent={NextImageAdapter} // default: a responsive <img> (lazy, sized; the hero eager)
  linkComponent={NextLinkAdapter}   // default: <a>
  hrefForPage={(page, locale) => …} // default: default locale at "/", others under "/<locale>"
  facts={registry}                  // prices and quotes shown from their facts; translations labelled
  contactFormAction="/api/…"        // without it the form is shown disabled (BF-048)
  agencyName="…"                    // named on the preview banner
  mode="development"                // throws on an unknown block; production skips and logs it
/>;
```

Static documents (Node): `renderStaticPage(spec, pageId, locale, { origin, inlineCss })` from
`@bf/site-blocks/static` returns `{ html, css }`; `renderStaticSite` renders every page × locale.

## Design rules

- **Server Components by default.** No client JavaScript for static blocks. The mobile menu and the photo viewer are
  native popovers. Islands (`'use client'`) only for "open now" (computed in the browser, in the business's time
  zone; the server renders an empty placeholder so HTML is deterministic), the contact form and the booking embed
  (loaded only when the visitor asks).
- **Styles are data.** `src/styles/families/*.ts` hold each family's tokens; `themeToCssVars(theme)` turns the
  theme and its family into `--bf-*` variables and `themeDataAttributes` into `data-*` switches. `base.css` reads only
  those: change a family's file, not a component.
- **No third-party request at runtime.** Fonts are copied from Fontsource (latin + latin-ext) into `dist/fonts/`;
  maps are a link to OpenStreetMap (or a static image on our storage via `mapImage`); icons are inline SVG.
- **Rich text** is rendered from `parseRichText` (BF-033), never a markdown library.
- **Accessibility:** one `h1` (the hero), no skipped heading level, landmarks, a skip link, visible focus, 44 px
  targets, labels on every field, `prefers-reduced-motion` honoured.

## Adding a block or a variant

1. Add it to the schema and the catalog in `@bf/site-schema` (BF-033).
2. Write `src/blocks/<type>.tsx` and register it in `src/renderer/registry.ts` (the type requires every block type).
3. The test "renders its … variant" covers every type × variant from the schema; add focused tests for its logic.

## Scripts

| Script | What |
|---|---|
| `build` | `dist/styles.css` (Tailwind + @font-face) and `dist/fonts/` |
| `render:fixtures` | the four fixture sites × five styles into `dist/sites/` (placeholder photos) |
| `serve` | serves `dist/sites/` on http://127.0.0.1:4410 |

Licenses of the fonts and icons: [LICENSES.md](LICENSES.md).
