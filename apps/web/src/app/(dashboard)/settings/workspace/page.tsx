import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { WorkspaceSettings } from '@/components/settings/workspace-settings.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('workspaceSettings'))('title') };
}

export default async function WorkspacePage() {
  const t = await getTranslations('workspaceSettings');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <WorkspaceSettings />
    </>
  );
}
