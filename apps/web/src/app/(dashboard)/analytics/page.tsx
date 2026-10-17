import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AnalyticsPage } from '@/features/analytics/analytics-page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('analytics') };
}

export default async function Page() {
  const t = await getTranslations('analytics');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <AnalyticsPage />
    </>
  );
}
