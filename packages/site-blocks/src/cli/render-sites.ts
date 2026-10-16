// pnpm --filter @bf/site-blocks render:fixtures — the four fixture sites rendered statically in every style family
// (BF-034), with placeholder photos: dist/sites/<fixture>/<style>/… plus the shared stylesheet and fonts. The gallery,
// the visual, accessibility and Lighthouse suites read these files.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SiteSpec } from '@bf/site-schema';
import { defaultPageHref } from '../renderer/resolvers.ts';
import { renderStaticSite } from '../static/render-static-page.tsx';
import { STYLE_FAMILY_IDS, type StyleFamilyId } from '../styles/families/index.ts';
import { FIXTURE_NAMES, readFixture } from './fixtures.ts';
import { placeholderResolver, placeholderSvg } from './placeholders.ts';

const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
export const SITES_DIR = join(dist, 'sites');

/** A fixture in another style family (everything else unchanged). */
export const inStyle = (spec: SiteSpec, style: StyleFamilyId): SiteSpec => ({
  ...spec,
  theme: { ...spec.theme, style },
});

export function renderFixtureSites(): string[] {
  rmSync(SITES_DIR, { recursive: true, force: true });
  mkdirSync(join(SITES_DIR, 'assets'), { recursive: true });
  cpSync(join(dist, 'styles.css'), join(SITES_DIR, 'styles.css'));
  cpSync(join(dist, 'fonts'), join(SITES_DIR, 'fonts'), { recursive: true });
  const written: string[] = [];
  for (const name of FIXTURE_NAMES) {
    const fixture = readFixture(name);
    for (const asset of fixture.assets)
      writeFileSync(join(SITES_DIR, 'assets', `${asset.id}.svg`), placeholderSvg(asset, fixture));
    for (const style of STYLE_FAMILY_IDS) {
      const spec = inStyle(fixture, style);
      const base = `/${name}/${style}`;
      const { files } = renderStaticSite(spec, {
        assetsResolver: placeholderResolver(),
        hrefForPage: (page, locale, site) =>
          `${base}${defaultPageHref(page, locale, site).replace(/^\/$/, '')}/`.replace(/\/\/$/, '/'),
        mode: 'development',
      });
      for (const [path, html] of files) {
        const target = join(SITES_DIR, name, style, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, html);
        written.push(`${name}/${style}/${path}`);
      }
    }
  }
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const written = renderFixtureSites();
  console.log(`Rendered ${written.length} pages into ${SITES_DIR}`);
}
