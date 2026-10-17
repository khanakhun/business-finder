import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import * as React from 'react';
import { PageSkeleton } from '@/components/states/page-skeleton.tsx';
import { LeadsInbox } from '@/features/leads/leads-inbox.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('leads'))('title') };
}

export default function Page() {
  return (
    <React.Suspense fallback={<PageSkeleton />}>
      <LeadsInbox />
    </React.Suspense>
  );
}
