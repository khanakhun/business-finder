import type { BusinessDetail, CrmState, Permission } from '@bf/contracts';
import type * as React from 'react';
import { createRegistry } from '@/lib/registry.ts';

// Tabs of the business page (BF-024). The built-in Overview, Contacts and Activity tabs are registered like the
// ones later tickets add (Website audit BF-030, Reviews BF-029, Scores BF-032, Sites BF-046, Outreach BF-052).

export interface BusinessTabProps {
  readonly business: BusinessDetail;
  readonly crm: CrmState;
}

export interface BusinessTab {
  /** Also the `?tab=` value. */
  readonly id: string;
  /** Message key of the tab label (`business.tabs.*` for the built-in ones). */
  readonly labelKey: string;
  readonly order: number;
  /** Hidden from users without it. */
  readonly permission?: Permission;
  /** Lazy-loaded (next/dynamic): only the open tab's code is fetched. */
  readonly component: React.ComponentType<BusinessTabProps>;
}

export const businessTabs = createRegistry<BusinessTab>();

/** The tabs a user sees, in order. */
export function visibleTabs(permissions: ReadonlySet<Permission>): BusinessTab[] {
  return businessTabs.list().filter((tab) => !tab.permission || permissions.has(tab.permission));
}
