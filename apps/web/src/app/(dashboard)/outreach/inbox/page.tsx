import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { KillSwitchBanner } from '@/features/deliverability/kill-switch-banner.tsx';
import { InboxPage } from '@/features/inbox/inbox-page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('inbox'))('title') };
}

export default async function OutreachInboxPage() {
  const t = await getTranslations('inbox');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <KillSwitchBanner />
      <InboxPage />
    </>
  );
}
