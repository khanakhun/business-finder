import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuditLog } from '@/components/settings/audit-log.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('audit'))('title') };
}

export default async function AuditLogPage() {
  const t = await getTranslations('audit');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <AuditLog />
    </>
  );
}
