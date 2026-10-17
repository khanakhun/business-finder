import { PageHeader } from '@bf/ui/components/page-header';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LiaEditor } from '@/features/compliance/lia-editor.tsx';
import { PoliciesMatrix } from '@/features/compliance/policies-matrix.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('compliance.settings'))('title') };
}

export default async function ComplianceSettingsPage() {
  const t = await getTranslations('compliance.settings');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="space-y-10">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t('policies')}</h2>
          <PoliciesMatrix />
        </section>
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t('lawfulBasis')}</h2>
          <LiaEditor />
        </section>
      </div>
    </>
  );
}
