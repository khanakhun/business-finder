import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TaxonomySettings } from '@/components/settings/taxonomy-settings.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('taxonomy'))('title') };
}

export default async function TaxonomyPage() {
  const t = await getTranslations('taxonomy');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <TaxonomySettings />
    </>
  );
}
