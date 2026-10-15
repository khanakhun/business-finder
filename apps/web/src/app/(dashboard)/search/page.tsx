import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import * as React from 'react';
import { PageSkeleton } from '@/components/states/page-skeleton.tsx';
import { SearchPage } from '@/features/search/search-page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('search') };
}

export default function Page() {
  // The search state lives in the URL (useSearchParams): render it inside a Suspense boundary.
  return (
    <React.Suspense fallback={<PageSkeleton />}>
      <SearchPage />
    </React.Suspense>
  );
}
