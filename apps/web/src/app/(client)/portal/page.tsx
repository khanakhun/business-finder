import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PortalSitesList } from '@/features/portal/sites-list.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('portal'))('title') };
}

export default async function PortalPage() {
  const t = await getTranslations('portal');
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('sitesTitle')}</h1>
      <PortalSitesList />
    </div>
  );
}
