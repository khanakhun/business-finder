import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ModelsHost } from '@/features/scoring/models/models-host.tsx';
import { ProfilesSettings } from '@/features/scoring/settings/profiles-settings.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('scoringSettings'))('title') };
}

export default async function ScoringSettingsPage() {
  const t = await getTranslations('scoringSettings');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <ProfilesSettings />
      <div className="mt-10">
        <ModelsHost />
      </div>
    </>
  );
}
