import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FeaturesSettings } from '@/components/settings/features-settings.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('features'))('title') };
}

export default async function FeaturesPage() {
  const t = await getTranslations('features');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <FeaturesSettings />
    </>
  );
}
