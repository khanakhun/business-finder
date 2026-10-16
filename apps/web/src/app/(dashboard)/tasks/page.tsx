import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import * as React from 'react';
import { PageSkeleton } from '@/components/states/page-skeleton.tsx';
import { TasksPage } from '@/features/tasks/tasks-page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('tasks'))('title') };
}

export default function Page() {
  return (
    <React.Suspense fallback={<PageSkeleton />}>
      <TasksPage />
    </React.Suspense>
  );
}
