import type { Page, SiteLocale, SiteSpec } from '@bf/site-schema';
import type { CSSProperties } from 'react';
import { PreviewBanner, SkipLink } from '../layout/chrome.tsx';
import { Footer } from '../layout/footer.tsx';
import { Header } from '../layout/header.tsx';
import { themeDataAttributes, themeToCssVars } from '../styles/theme-vars.ts';
import { BlockRenderer, blockTones } from './block-renderer.tsx';
import { createRenderContext } from './resolvers.ts';
import type { RenderOptions } from './types.ts';

export interface SitePageProps extends RenderOptions {
  readonly spec: SiteSpec;
  /** The page, or its id. */
  readonly page: Page | string;
  readonly locale: SiteLocale;
}

/** The page a spec's page is in a locale. Throws when the page does not exist. */
export function findPage(spec: SiteSpec, page: Page | string): Page {
  if (typeof page !== 'string') return page;
  const found = spec.pages.find((candidate) => candidate.id === page);
  if (!found) throw new Error(`The site has no page "${page}".`);
  return found;
}

/**
 * A whole page of a site (Server Component): theme variables, skip link, preview banner, header, the page's blocks
 * and the footer. The same component renders in apps/sites, the editor canvas and the static renderer; the image and
 * link components are injected (`imageComponent`, `linkComponent`).
 */
export function SitePage({ spec, page, locale, ...options }: SitePageProps) {
  const current = findPage(spec, page);
  const ctx = createRenderContext(spec, current, locale, options);
  const tones = blockTones(current.blocks);
  return (
    <div
      className="bf-site"
      lang={locale}
      style={themeToCssVars(spec.theme) as CSSProperties}
      {...themeDataAttributes(spec.theme)}
    >
      <SkipLink ctx={ctx} />
      <PreviewBanner ctx={ctx} />
      <Header ctx={ctx} />
      <main id="main" tabIndex={-1}>
        {current.blocks.map((block, index) => (
          <BlockRenderer key={block.id} block={block} ctx={ctx} index={index} tone={tones[index]} />
        ))}
      </main>
      <Footer ctx={ctx} />
    </div>
  );
}
