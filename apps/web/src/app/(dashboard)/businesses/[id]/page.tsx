import type { BusinessDetail, CrmState } from '@bf/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import * as React from 'react';
import { PageSkeleton } from '@/components/states/page-skeleton.tsx';
import { BusinessDetailPage } from '@/features/business/detail-page.tsx';
import { serverGet } from '@/lib/server-api.ts';

type Props = { readonly params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Business and CRM state fetched on the server (one request each, in parallel); the client keeps them fresh. */
async function load(id: string) {
  const [business, crm] = await Promise.all([
    serverGet<BusinessDetail>(`/v1/businesses/${id}`),
    serverGet<CrmState>(`/v1/businesses/${id}/crm`),
  ]);
  return { business, crm };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  if (!UUID.test(id)) return { title: (await getTranslations('business'))('title') };
  const { business } = await load(id);
  return { title: business.ok ? business.data.displayName : (await getTranslations('business'))('title') };
}

export default async function Page({ params }: Props) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { business, crm } = await load(id);
  // Not tracked by this workspace (or not a business at all). Other failures: the client shows its error state.
  if ((!business.ok && business.status === 404) || (!crm.ok && crm.status === 404)) notFound();
  return (
    <React.Suspense fallback={<PageSkeleton />}>
      <BusinessDetailPage
        id={id}
        {...(business.ok ? { initialBusiness: business.data } : {})}
        {...(crm.ok ? { initialCrm: crm.data } : {})}
      />
    </React.Suspense>
  );
}
