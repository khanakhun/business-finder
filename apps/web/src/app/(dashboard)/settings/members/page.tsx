import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MembersSettings } from '@/components/settings/members-settings.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('members'))('title') };
}

export default async function MembersPage() {
  const t = await getTranslations('members');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <MembersSettings />
    </>
  );
}
