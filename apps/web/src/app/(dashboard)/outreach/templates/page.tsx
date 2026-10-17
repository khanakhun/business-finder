import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TemplatesPage } from '@/features/outreach/templates/templates-page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('templatesPage'))('title') };
}

export default async function OutreachTemplatesPage() {
  const t = await getTranslations('templatesPage');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <TemplatesPage />
    </>
  );
}
