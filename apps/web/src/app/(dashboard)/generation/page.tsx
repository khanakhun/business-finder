import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import * as React from 'react';
import { PageSkeleton } from '@/components/states/page-skeleton.tsx';
import { GenerationHome } from '@/features/generation/home/generation-home.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('generation') };
}

export default function Page() {
  return (
    <React.Suspense fallback={<PageSkeleton />}>
      <GenerationHome />
    </React.Suspense>
  );
}
