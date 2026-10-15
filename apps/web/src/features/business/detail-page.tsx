'use client';

import type { BusinessDetail, CrmState, Permission } from '@bf/contracts';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@bf/ui/components/tabs';
import { TooltipProvider } from '@bf/ui/components/tooltip';
import { useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { useSession } from '@/lib/session.tsx';
import { registerDefaultActivityRenderers } from './activity/defaults.tsx';
import { useBusiness, useCrmState } from './api.ts';
import { DuplicatesBanner } from './duplicates/banner.tsx';
import { BusinessHeader } from './header.tsx';
import { registerDefaultTabs } from './tabs/defaults.ts';
import { visibleTabs } from './tabs/registry.ts';

registerDefaultTabs();
registerDefaultActivityRenderers();

/**
 * The business page (BF-024): a plug-in host. The header, tabs and quick actions come from registries, so the
 * audit, reviews, scores, sites and outreach tickets add their parts without editing this page.
 */
export function BusinessDetailPage({
  id,
  initialBusiness,
  initialCrm,
}: {
  readonly id: string;
  readonly initialBusiness?: BusinessDetail;
  readonly initialCrm?: CrmState;
}) {
  const t = useTranslations('business');
  const all = useTranslations();
  const errorLabels = useErrorLabels();
  const me = useSession();
  const business = useBusiness(id, initialBusiness);
  const crm = useCrmState(id, initialCrm);
  const permissions = React.useMemo(() => new Set<Permission>(me.permissions), [me.permissions]);
  const tabs = visibleTabs(permissions);
  const [tab, setTab] = useQueryState('tab', parseAsString.withDefault(tabs[0]?.id ?? 'overview'));
  const active = tabs.some((candidate) => candidate.id === tab) ? tab : (tabs[0]?.id ?? 'overview');

  if (business.isError || crm.isError) {
    return (
      <ErrorState
        problem={toProblemLike(business.error ?? crm.error, t('error'))}
        labels={errorLabels}
        onRetry={() => {
          void business.refetch();
          void crm.refetch();
        }}
      />
    );
  }
  if (!business.data || !crm.data) {
    return (
      <div className="space-y-4" aria-busy>
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-5 w-96" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const detail = business.data;
  const state = crm.data;
  return (
    <TooltipProvider>
      <div className="space-y-5">
        <BusinessHeader business={detail} crm={state} />
        <DuplicatesBanner business={detail} />
        <Tabs value={active} onValueChange={(value) => void setTab(value)}>
          <TabsList>
            {tabs.map((entry) => (
              <TabsTrigger key={entry.id} value={entry.id}>
                {all(entry.labelKey as never)}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map(({ id: tabId, component: Tab }) => (
            <TabsContent key={tabId} value={tabId} className="pt-4">
              {tabId === active ? <Tab business={detail} crm={state} /> : null}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </TooltipProvider>
  );
}
