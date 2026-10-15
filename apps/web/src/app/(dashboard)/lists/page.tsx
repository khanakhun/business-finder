import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ListsPage } from '@/features/search/collections-pages.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('search.lists'))('title') };
}

export default async function Page() {
  const t = await getTranslations('search.lists');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <ListsPage />
    </>
  );
}
