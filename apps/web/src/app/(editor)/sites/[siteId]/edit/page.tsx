import type { SiteDetail, SiteVersion } from '@bf/contracts';
import { EmptyState } from '@bf/ui/components/empty-state';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LazySiteEditor } from '@/features/site-editor/lazy-editor.tsx';
import { serverGet } from '@/lib/server-api.ts';

type Props = { readonly params: Promise<{ siteId: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('siteEditor'))('title') };
}

/** The site editor (BF-037): the site and its current version, loaded on the server; the editor itself is lazy. */
export default async function Page({ params }: Props) {
  const { siteId } = await params;
  if (!UUID.test(siteId)) notFound();
  const t = await getTranslations('siteEditor');
  const site = await serverGet<SiteDetail>(`/v1/sites/${siteId}`);
  if (!site.ok) {
    if (site.status === 404) notFound();
    return <EmptyState title={t('notFound')} />;
  }
  const current = site.data.currentVersion;
  if (!current) return <EmptyState title={t('noVersion')} />;
  const version = await serverGet<SiteVersion>(`/v1/sites/${siteId}/versions/${current.id}`);
  if (!version.ok) return <EmptyState title={t('notFound')} />;
  return <LazySiteEditor siteId={siteId} initialSite={site.data} initialVersion={version.data} />;
}
