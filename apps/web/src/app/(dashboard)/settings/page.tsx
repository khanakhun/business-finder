import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LanguageMenu, ThemeMenu } from '@/components/shell/preferences.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('settings'))('title') };
}

export default async function SettingsPage() {
  const t = await getTranslations('settings');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <section aria-labelledby="appearance" className="max-w-2xl rounded-lg border bg-surface">
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="appearance" className="font-semibold">
              {t('appearance')}
            </h2>
            <p className="text-muted-foreground">{t('appearanceDescription')}</p>
          </div>
          <div className="flex items-center gap-1">
            <LanguageMenu />
            <ThemeMenu />
          </div>
        </div>
      </section>
    </>
  );
}
