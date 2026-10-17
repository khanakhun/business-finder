import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MailboxesPage } from '@/features/mailboxes/mailboxes-page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('mailboxes'))('title') };
}

export default async function MailboxesSettingsPage() {
  const t = await getTranslations('mailboxes');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <MailboxesPage />
    </>
  );
}
