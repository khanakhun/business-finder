import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import * as React from 'react';
import { PageSkeleton } from '@/components/states/page-skeleton.tsx';
import { PipelineBoardPage } from '@/features/pipeline/board.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('pipeline') };
}

export default function Page() {
  // Filters live in the URL (useSearchParams): render inside a Suspense boundary.
  return (
    <React.Suspense fallback={<PageSkeleton />}>
      <PipelineBoardPage />
    </React.Suspense>
  );
}
