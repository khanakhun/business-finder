import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NotificationsList } from '@/components/notifications/notifications-list.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('notifications'))('title') };
}

export default async function NotificationsPage() {
  const t = await getTranslations('notifications');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <NotificationsList />
    </>
  );
}
