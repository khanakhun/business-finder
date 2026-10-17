import { existsSync, readFileSync } from 'node:fs';
import { copyFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStylesheet, renderStaticPage, staticPath } from '@bf/site-blocks/static';
import type { SiteLocale, SiteSpec } from '@bf/site-schema';
import type { Workspace } from './workspace.ts';

// renderSite (BF-042): the site as static HTML with BF-034's renderer, its stylesheet and fonts copied next to it,
// and an index linking every page in every locale for review. Deterministic: same spec, same files.

export const RENDER_DIR = '.sitekit/render';

export interface RenderedPage {
  readonly pageId: string;
  readonly locale: SiteLocale;
  /** Workspace-relative path of the HTML file. */
  readonly file: string;
  /** URL path when the render folder is served at its root. */
  readonly url: string;
}

export interface RenderResult {
  readonly outDir: string;
  readonly pages: RenderedPage[];
  readonly index: string;
  readonly fonts: boolean;
}

/**
 * Where the block library's stylesheet and fonts are: next to the bundled CLI (`dist/site-blocks/`, BF-043's runner
 * image), else the package's build (`@bf/site-blocks/dist`). Absent in an unbuilt checkout: pages still render.
 */
export function blockAssetsDir(): string | undefined {
  const bundled = fileURLToPath(new URL('./site-blocks/', import.meta.url));
  if (existsSync(join(bundled, 'styles.css'))) return bundled;
  try {
    const renderer = createRequire(import.meta.url).resolve('@bf/site-blocks/static');
    const dir = join(dirname(dirname(dirname(renderer))), 'dist');
    return existsSync(join(dir, 'styles.css')) ? dir : undefined;
  } catch {
    return undefined;
  }
}

function fontsDir(): string | undefined {
  const root = blockAssetsDir();
  return root && existsSync(join(root, 'fonts')) ? join(root, 'fonts') : undefined;
}

function stylesheet(): string {
  const root = blockAssetsDir();
  return root ? readFileSync(join(root, 'styles.css'), 'utf8') : readStylesheet();
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

export async function renderSite(
  workspace: Workspace,
  spec: SiteSpec,
  options: { pages?: readonly string[]; locales?: readonly SiteLocale[]; outDir?: string; css?: string } = {},
): Promise<RenderResult> {
  const outDir = options.outDir ?? RENDER_DIR;
  const css = options.css ?? stylesheet();
  const pages: RenderedPage[] = [];
  for (const locale of spec.locales) {
    if (options.locales && !options.locales.includes(locale)) continue;
    for (const page of spec.pages) {
      if (options.pages && !options.pages.includes(page.id)) continue;
      const path = staticPath(spec, page, locale);
      const { html } = renderStaticPage(spec, page.id, locale, { css, stylesheetHref: '/styles.css' });
      await workspace.writeText(`${outDir}/${path}`, html);
      pages.push({
        pageId: page.id,
        locale,
        file: `${outDir}/${path}`,
        url: `/${path.replace(/index\.html$/, '')}`,
      });
    }
  }
  await workspace.writeText(`${outDir}/styles.css`, css);
  const fonts = fontsDir();
  if (fonts) {
    const target = await workspace.resolve(`${outDir}/fonts/.keep`);
    await workspace.writeText(`${outDir}/fonts/.keep`, '');
    for (const name of (await readdir(fonts)).sort())
      if (/^[a-z0-9-]+\.woff2$/.test(name)) await copyFile(join(fonts, name), join(dirname(target), name));
  }
  const links = pages
    .map(
      (page) =>
        `<li><a href="${escapeHtml(page.url)}">${escapeHtml(page.pageId)} · ${escapeHtml(page.locale)}</a></li>`,
    )
    .join('\n');
  const index = `${outDir}/_review.html`;
  await workspace.writeText(
    index,
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(spec.brand.name)} — review</title></head>\n<body><h1>${escapeHtml(spec.brand.name)}</h1><ul>\n${links}\n</ul></body></html>\n`,
  );
  return { outDir, pages, index, fonts: Boolean(fonts) };
}

/**
 * The asset URLs the rendered pages request on the given hosts (`src`, `srcset`, `href`, CSS `url()`), every page and
 * locale, without a browser (BF-045: the quality sandbox has no network, so the worker brings these files along).
 */
export function referencedAssetUrls(spec: SiteSpec, hosts: readonly string[]): string[] {
  const urls = new Set<string>();
  for (const locale of spec.locales)
    for (const page of spec.pages) {
      const { html } = renderStaticPage(spec, page.id, locale, { css: '', stylesheetHref: '/styles.css' });
      for (const match of html.matchAll(/https?:\/\/[^\s"'<>),]+/g)) {
        const url = match[0].replace(/&amp;/g, '&');
        try {
          if (hosts.includes(new URL(url).hostname)) urls.add(url);
        } catch {
          // Not a URL after all.
        }
      }
    }
  return [...urls].sort();
}
