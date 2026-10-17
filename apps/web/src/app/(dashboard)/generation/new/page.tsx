import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import * as React from 'react';
import { PageSkeleton } from '@/components/states/page-skeleton.tsx';
import { CreateSitesPage } from '@/features/generation/create/create-sites-page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('generation.create'))('title') };
}

/** "Create sites" for `?ids=…` (from the listing's bulk action, a business's header, or a link). */
export default function Page() {
  return (
    <React.Suspense fallback={<PageSkeleton />}>
      <CreateSitesPage />
    </React.Suspense>
  );
}
