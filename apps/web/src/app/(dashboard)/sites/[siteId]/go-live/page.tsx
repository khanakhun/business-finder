import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { GoLiveWizard } from '@/features/sites/go-live/wizard.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('goLive'))('title') };
}

/** Taking a site live (BF-062): the readiness checks and the steps that fix them. */
export default async function GoLivePage({ params }: { readonly params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const t = await getTranslations('goLive');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <Suspense>
        <GoLiveWizard siteId={siteId} />
      </Suspense>
    </>
  );
}
