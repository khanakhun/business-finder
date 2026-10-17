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
    // BF-046.
    id: 'sites',
    labelKey: 'business.tabs.sites',
    order: 29,
    permission: 'sites:read',
    component: dynamic(
      () => import('@/features/generation/business-tab/sites-tab.tsx').then((m) => m.SitesTab),
      {
        loading: TabSkeleton,
      },
    ),
  });
  businessTabs.register({
    // BF-049.
    id: 'compliance',
    labelKey: 'business.tabs.compliance',
    order: 29.5,
    component: dynamic(
      () => import('@/features/compliance/compliance-tab.tsx').then((m) => m.ComplianceTab),
      {
        loading: TabSkeleton,
      },
    ),
  });
  businessTabs.register({
    // BF-053.
    id: 'sequences',
    labelKey: 'business.tabs.sequences',
    order: 29.7,
    permission: 'outreach:send',
    component: dynamic(() => import('@/features/sequences/business-tab.tsx').then((m) => m.SequencesTab), {
      loading: TabSkeleton,
    }),
  });
  businessTabs.register({
    // BF-057.
    id: 'call',
    labelKey: 'business.tabs.call',
    order: 29.6,
    permission: 'outreach:send',
    component: dynamic(() => import('@/features/assist/call-tab.tsx').then((m) => m.CallTab), {
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
