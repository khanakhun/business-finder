import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ApiStatus } from '@/components/api-status.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('home'))('title') };
}

export default async function HomePage() {
  const t = await getTranslations('home');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <ApiStatus />
    </>
  );
}
