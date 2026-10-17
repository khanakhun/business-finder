import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SequencesPage } from '@/features/sequences/sequences-page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('sequences'))('title') };
}

export default async function OutreachSequencesPage() {
  const t = await getTranslations('sequences');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <SequencesPage />
    </>
  );
}
