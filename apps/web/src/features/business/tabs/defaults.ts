import dynamic from 'next/dynamic';
import { businessTabs } from './registry.ts';
import { TabSkeleton } from './tab-skeleton.tsx';

let registered = false;

/** The built-in tabs (idempotent). */
export function registerDefaultTabs(): void {
  if (registered) return;
  registered = true;
  businessTabs.register({
    id: 'overview',
    labelKey: 'business.tabs.overview',
    order: 10,
    component: dynamic(() => import('./overview.tsx').then((m) => m.OverviewTab), { loading: TabSkeleton }),
  });
  businessTabs.register({
    id: 'contacts',
    labelKey: 'business.tabs.contacts',
    order: 20,
    component: dynamic(() => import('./contacts.tsx').then((m) => m.ContactsTab), { loading: TabSkeleton }),
  });
  businessTabs.register({
    // BF-027 (BF-030 adds the audit to it).
    id: 'website',
    labelKey: 'business.tabs.website',
    order: 25,
    component: dynamic(() => import('@/features/enrichment/website-tab.tsx').then((m) => m.WebsiteTab), {
      loading: TabSkeleton,
    }),
  });
  businessTabs.register({
    // BF-029.
    id: 'reviews',
    labelKey: 'business.tabs.reviews',
    order: 27,
    component: dynamic(() => import('@/features/reviews/reviews-tab.tsx').then((m) => m.ReviewsTab), {
      loading: TabSkeleton,
    }),
  });
  businessTabs.register({
    id: 'scores',
    labelKey: 'business.tabs.scores',
    order: 28,
    component: dynamic(() => import('@/features/scoring/scores-tab.tsx').then((m) => m.ScoresTab), {
      loading: TabSkeleton,
    }),
  });
  businessTabs.register({
    id: 'activity',
    labelKey: 'business.tabs.activity',
    order: 30,
    component: dynamic(() => import('./activity.tsx').then((m) => m.ActivityTab), { loading: TabSkeleton }),
  });
}
