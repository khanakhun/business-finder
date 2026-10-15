import { getTranslations } from 'next-intl/server';
import type * as React from 'react';
import { BrandMark } from '@/components/shell/brand-mark.tsx';
import { LanguageMenu, ThemeMenu } from '@/components/shell/preferences.tsx';

/** Sign-in, sign-up, verification, reset, invitation and 2FA pages: no dashboard shell. */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations();
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex items-center justify-between px-4 py-3 sm:px-8">
        <span className="flex items-center gap-2 font-semibold">
          <BrandMark className="size-6" />
          {t('app.name')}
        </span>
        <div className="flex items-center gap-1">
          <LanguageMenu />
          <ThemeMenu />
        </div>
      </header>
      <main id="content" className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pb-16">
        <p className="text-center text-muted-foreground">{t('auth.brandTagline')}</p>
        {children}
      </main>
    </div>
  );
}
