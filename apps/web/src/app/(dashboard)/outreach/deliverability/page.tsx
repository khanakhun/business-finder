import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { DeliverabilityPage } from '@/features/deliverability/deliverability-page.tsx';
import { KillSwitchBanner } from '@/features/deliverability/kill-switch-banner.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('deliverability'))('title') };
}

export default async function OutreachDeliverabilityPage() {
  const t = await getTranslations('deliverability');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <KillSwitchBanner />
      <DeliverabilityPage />
    </>
  );
}
