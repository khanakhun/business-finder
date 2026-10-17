import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PortalSiteView } from '@/features/portal/portal-site.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('portal'))('title') };
}

export default async function PortalSitePage({ params }: { readonly params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const t = await getTranslations('portal');
  return (
    <div className="space-y-4">
      <Link href="/portal" className="text-sm text-primary underline-offset-2 hover:underline">
        {t('back')}
      </Link>
      <PortalSiteView siteId={siteId} />
    </div>
  );
}
