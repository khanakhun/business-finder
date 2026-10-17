import { PageHeader } from '@bf/ui/components/page-header';
import { getTranslations } from 'next-intl/server';
import type * as React from 'react';
import { ComplianceNav } from '@/features/compliance/admin/compliance-nav.tsx';

export default async function ComplianceLayout({ children }: { readonly children: React.ReactNode }) {
  const t = await getTranslations('complianceAdmin');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <p className="-mt-2 mb-4 text-xs text-muted-foreground">
        <a
          href="https://github.com/khanakhun/business-finder/blob/main/docs/compliance/data-map.md"
          target="_blank"
          rel="noopener noreferrer"
          className="text-lagoon hover:underline"
        >
          {t('dataMap')}
        </a>
      </p>
      <ComplianceNav />
      {children}
    </>
  );
}
