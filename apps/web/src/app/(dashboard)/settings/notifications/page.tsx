import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NotificationPreferencesSettings } from '@/components/settings/notification-preferences.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('notifications.preferences'))('title') };
}

export default async function NotificationSettingsPage() {
  const t = await getTranslations('notifications.preferences');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <NotificationPreferencesSettings />
    </>
  );
}
