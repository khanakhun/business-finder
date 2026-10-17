import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { OutboxPage } from '@/features/outreach/outbox/outbox-page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('outbound.outbox'))('title') };
}

export default async function OutreachOutboxPage() {
  const t = await getTranslations('outbound.outbox');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <OutboxPage />
    </>
  );
}
