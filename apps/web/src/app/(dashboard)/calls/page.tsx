import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CallListPage } from '@/features/assist/call-list/page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('assist.list'))('title') };
}

export default async function CallsPage() {
  const t = await getTranslations('assist.list');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <CallListPage />
    </>
  );
}
