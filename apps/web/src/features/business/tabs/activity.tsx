'use client';

import { Timeline } from '../activity/timeline.tsx';
import { NotesSection } from '../notes.tsx';
import { BusinessTasksPanel } from '../tasks.tsx';
import type { BusinessTabProps } from './registry.ts';

/** Notes and the timeline on the left; open tasks on the right. */
export function ActivityTab({ business }: BusinessTabProps) {
  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="min-w-0 space-y-8">
        <NotesSection businessId={business.id} />
        <Timeline businessId={business.id} />
      </div>
      <BusinessTasksPanel businessId={business.id} />
    </div>
  );
}
