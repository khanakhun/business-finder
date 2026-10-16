import type { Metadata } from 'next';
import { Atkinson_Hyperlegible_Next } from 'next/font/google';
import { headers } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import type * as React from 'react';
import { Providers } from './providers.tsx';
import './globals.css';

// Designed for legibility (distinct I/l/1, open shapes): the dashboard is read for hours by non-specialists.
const font = Atkinson_Hyperlegible_Next({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-app',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'Business Finder', template: '%s · Business Finder' },
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  // Reading headers makes every page dynamic, which per-request CSP nonces require.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang={locale} className={font.variable} suppressHydrationWarning>
      <body>
        <NextIntlClientProvider>
          <Providers nonce={nonce}>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
