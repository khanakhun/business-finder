import '@bf/site-blocks/styles.css';
import './renderer.css';
import type { ReactNode } from 'react';
import { currentSite } from '@/lib/current-site.ts';
import { resolveRoute } from '@/lib/locale-routing.ts';

/**
 * The document of every site page: its language is the page's (the path's locale prefix, else the site's default).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const site = await currentSite();
  const segments = (site?.path ?? '/').split('/').filter(Boolean);
  const lang = site
    ? (resolveRoute(site.tenant.spec, segments)?.locale ?? site.tenant.spec.defaultLocale)
    : 'en';
  return (
    <html lang={lang}>
      <body>{children}</body>
    </html>
  );
}
