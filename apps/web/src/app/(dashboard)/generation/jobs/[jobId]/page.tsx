import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import * as React from 'react';
import { PageSkeleton } from '@/components/states/page-skeleton.tsx';
import { JobConsole } from '@/features/generation/console/job-console.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('generation.console'))('title') };
}

export default async function Page({ params }: { readonly params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return (
    <React.Suspense fallback={<PageSkeleton />}>
      <JobConsole jobId={jobId} />
    </React.Suspense>
  );
}
