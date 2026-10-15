import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('apiKeys'))('title') };
}

export default async function ApiKeysPage() {
  const t = await getTranslations('apiKeys');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <ApiKeysSettings />
    </>
  );
}
