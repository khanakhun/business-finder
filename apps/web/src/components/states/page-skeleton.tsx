import { Skeleton } from '@bf/ui/components/skeleton';

/**
 * Page-level loading convention: a page's own `loading.tsx` re-exports this (title + content skeletons).
 * Not used as a section-wide boundary: streaming starts before `notFound()`, which would turn 404s into 200s.
 */
export function PageSkeleton() {
  return (
    <div aria-busy="true" className="space-y-6">
      <div className="space-y-2 pb-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
