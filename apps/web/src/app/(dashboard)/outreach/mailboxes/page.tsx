import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MailboxesPage } from '@/features/mailboxes/mailboxes-page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('mailboxes'))('title') };
}

/** The outreach section's entry to the mailboxes (the same page as Settings → Mailboxes, BF-050). */
export default async function OutreachMailboxesPage() {
  const t = await getTranslations('mailboxes');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <MailboxesPage />
    </>
  );
}
