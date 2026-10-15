import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AccountSettings } from '@/components/settings/account-settings.tsx';
import { getIdentityConfig } from '@/lib/server-session.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('account'))('title') };
}

export default async function AccountPage() {
  const t = await getTranslations('account');
  const config = await getIdentityConfig();
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <AccountSettings minPasswordLength={config.minPasswordLength} />
    </>
  );
}
