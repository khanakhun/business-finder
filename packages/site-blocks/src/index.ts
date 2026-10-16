// @bf/site-blocks (BF-034): the block library every SiteSpec site renders with — in apps/sites, the editor canvas
// and the static renderer (`@bf/site-blocks/static`). The stylesheet is `@bf/site-blocks/styles.css` (built).

export { FONT_FAMILIES, fontStacks, pairPreloads } from './fonts/families.ts';
export { formatSpan, formatTime, groupDays, openStatus, timeZoneOf, weekdayName } from './format/hours.ts';
export { formatPhone } from './format/phone.ts';
export { formatPrice } from './format/price.ts';
export { UI_STRINGS, type UiStrings, uiStrings } from './i18n/strings.ts';
// The page chrome around the blocks: the editor's canvas (BF-037) frames them as SitePage does.
export { PreviewBanner, SkipLink } from './layout/chrome.tsx';
export { Footer } from './layout/footer.tsx';
export { Header } from './layout/header.tsx';
export { BlockRenderer, blockTones, UnknownBlockError } from './renderer/block-renderer.tsx';
export { PlainLink, ResponsiveImage } from './renderer/defaults.tsx';
export { BOOKING_EMBED_HOSTS, embedOrigins } from './renderer/embeds.ts';
export { faviconHref } from './renderer/favicon.ts';
export { BLOCK_COMPONENTS } from './renderer/registry.ts';
export {
  createRenderContext,
  defaultPageHref,
  mapLink,
  pickText,
  resolveCta,
  resolveImage,
} from './renderer/resolvers.ts';
export { findPage, PageNotFoundError, SitePage, type SitePageProps } from './renderer/site-page.tsx';
export type * from './renderer/types.ts';
export {
  STYLE_FAMILIES,
  STYLE_FAMILY_IDS,
  type StyleFamily,
  type StyleFamilyId,
} from './styles/families/index.ts';
export {
  type CssVars,
  cssVarsText,
  familyVars,
  themeDataAttributes,
  themeToCssVars,
} from './styles/theme-vars.ts';
