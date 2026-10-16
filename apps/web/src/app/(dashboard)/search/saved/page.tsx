import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SavedSearchesPage } from '@/features/search/collections-pages.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('search.saved'))('title') };
}

export default async function Page() {
  const t = await getTranslations('search.saved');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <SavedSearchesPage />
    </>
  );
}
