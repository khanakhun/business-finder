import './renderer.css';
import { pairPreloads } from '@bf/site-blocks';
import type { ReactNode } from 'react';
import { currentSite } from '@/lib/current-site.ts';
import { localeOfPath } from '@/lib/locale-routing.ts';
import { BLOCKS_BASE } from '@/lib/static-files.ts';

/**
 * The document of every site page: its language is the page's (the path's locale prefix, else the site's default).
 * The block library's stylesheet and fonts are served at stable paths (scripts/next.mjs copies them to
 * public/_bf), so the site's two fonts are preloaded and its text never reflows when they arrive (no layout shift).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const site = await currentSite();
  const segments = (site?.path ?? '/').split('/').filter(Boolean);
  const lang = site ? localeOfPath(site.tenant.spec, segments) : 'en';
  const fonts = site ? pairPreloads(site.tenant.spec.theme.typography.pairId) : [];
  return (
    <html lang={lang}>
      <head>
        {fonts.map((file) => (
          <link
            key={file}
            rel="preload"
            href={`${BLOCKS_BASE}/fonts/${file}`}
            as="font"
            type="font/woff2"
            crossOrigin="anonymous"
          />
        ))}
        <link rel="stylesheet" href={`${BLOCKS_BASE}/site-blocks.css`} />
      </head>
      <body>{children}</body>
    </html>
  );
}
