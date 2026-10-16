import type { Activity } from '@bf/contracts';
import type { LucideIcon } from 'lucide-react';
import type * as React from 'react';
import { createRegistry } from '@/lib/registry.ts';

// How each activity type reads in the timeline (BF-024). Later tickets register renderers for their types
// (`outreach.*`, `site.*`, `generation.*`, `score.updated`); unknown types fall back to a generic line.

export interface ActivityRendererProps {
  readonly activity: Activity;
}

export interface ActivityRenderer {
  /** The activity type it renders (also its registry id). */
  readonly id: string;
  readonly order: number;
  readonly icon: LucideIcon;
  /** One sentence (may use hooks: translations, teammates). */
  readonly component: React.ComponentType<ActivityRendererProps>;
}

export const activityRenderers = createRegistry<ActivityRenderer>();
