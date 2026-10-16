import { Skeleton } from '@bf/ui/components/skeleton';

export function TabSkeleton() {
  return (
    <div className="space-y-3 pt-2" aria-hidden>
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
