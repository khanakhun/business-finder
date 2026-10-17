import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type * as React from 'react';
import { BrandMark } from '@/components/shell/brand-mark.tsx';
import { LanguageMenu, ThemeMenu } from '@/components/shell/preferences.tsx';
import { PortalSignOut } from '@/features/portal/sign-out.tsx';
import { getSession } from '@/lib/server-session.ts';

/** The client portal (BF-062): no dashboard shell, only the business owner's sites. */
export default async function ClientLayout({ children }: { children: React.ReactNode }) {
  if (!(await getSession())) redirect('/portal/sign-in');
  const t = await getTranslations();
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex items-center justify-between border-b px-4 py-3 sm:px-8">
        <span className="flex items-center gap-2 font-semibold">
          <BrandMark className="size-6" />
          {t('portal.title')}
        </span>
        <div className="flex items-center gap-1">
          <LanguageMenu />
          <ThemeMenu />
          <PortalSignOut />
        </div>
      </header>
      <main id="content" className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
        {children}
      </main>
    </div>
  );
}
