import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { IntegrationsSettings } from '@/components/settings/integrations-settings.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('integrations'))('title') };
}

export default async function IntegrationsPage() {
  const t = await getTranslations('integrations');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <IntegrationsSettings />
    </>
  );
}
