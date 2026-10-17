import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { KillSwitchBanner } from '@/features/deliverability/kill-switch-banner.tsx';
import { ApprovalsPage } from '@/features/outreach/approvals/approvals-page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('outbound.approvals'))('title') };
}

export default async function OutreachApprovalsPage() {
  const t = await getTranslations('outbound.approvals');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <KillSwitchBanner />
      <ApprovalsPage />
    </>
  );
}
