'use client';

import { Skeleton } from '@bf/ui/components/skeleton';
import dynamic from 'next/dynamic';

/** The Models section (BF-059), loaded on demand: its charts stay out of the settings page's first load. */
export const ModelsHost = dynamic(() => import('./models-section.tsx').then((m) => m.ModelsSection), {
  ssr: false,
  loading: () => <Skeleton className="h-40 w-full" />,
});
