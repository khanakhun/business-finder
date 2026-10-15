import type { BusinessDetail, CrmState, Permission } from '@bf/contracts';
import type { LucideIcon } from 'lucide-react';
import { createRegistry } from '@/lib/registry.ts';

// Quick actions in the business page header (BF-024). Later tickets register theirs, or replace a placeholder by
// id: Enrich now (BF-027), Generate site (BF-046), Send email (BF-052), WhatsApp message (BF-057).

export interface QuickActionContext {
  readonly business: BusinessDetail;
  readonly crm: CrmState;
  readonly permissions: ReadonlySet<Permission>;
}

export interface QuickAction {
  readonly id: string;
  /** Message key of the label. */
  readonly labelKey: string;
  readonly icon: LucideIcon;
  readonly order: number;
  readonly permission?: Permission;
  /** Not offered at all for this business (e.g. no phone number to call). */
  hidden?(context: QuickActionContext): boolean;
  /** A message key explaining why the action is not available (tooltip), or null when it is. */
  disabledReason?(context: QuickActionContext): string | null;
  /** A link action (opens in a new tab when external). */
  href?(context: QuickActionContext): string | null;
  run?(context: QuickActionContext): void | Promise<void>;
}

export const quickActions = createRegistry<QuickAction>();

export interface QuickActionAvailability {
  readonly action: QuickAction;
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly href: string | null;
}

/** The actions to show for a business and user, in order. */
export function quickActionsFor(context: QuickActionContext): QuickActionAvailability[] {
  return quickActions
    .list()
    .filter((action) => !action.permission || context.permissions.has(action.permission))
    .filter((action) => !action.hidden?.(context))
    .map((action) => {
      const reason = action.disabledReason?.(context) ?? null;
      return { action, enabled: reason === null, reason, href: action.href?.(context) ?? null };
    });
}
