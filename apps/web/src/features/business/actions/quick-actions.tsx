'use client';

import type { BusinessDetail, CrmState, Permission } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@bf/ui/components/tooltip';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useSession } from '@/lib/session.tsx';
import { registerDefaultQuickActions } from './defaults.ts';
import { quickActionsFor } from './registry.ts';

registerDefaultQuickActions();

/** The registered quick actions for this business (links, calls, and what later tickets add). */
export function QuickActions({
  business,
  crm,
}: {
  readonly business: BusinessDetail;
  readonly crm: CrmState;
}) {
  const t = useTranslations();
  const me = useSession();
  const permissions = React.useMemo(() => new Set<Permission>(me.permissions), [me.permissions]);
  const context = { business, crm, permissions };
  const ui = {
    t: (key: string, values?: Record<string, string | number>) => t(key as never, values as never),
  };
  return (
    <div
      role="toolbar"
      aria-label={t('business.actions.label')}
      className="flex flex-wrap items-center gap-1.5"
    >
      {quickActionsFor(context).map(({ action, enabled, reason, href }) => {
        const Icon = action.icon;
        const label = t(action.labelKey as never);
        const external = href?.startsWith('http') ?? false;
        const button =
          enabled && href ? (
            <Button asChild size="sm" variant="outline">
              <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                <Icon aria-hidden />
                {label}
              </a>
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              // aria-disabled keeps it focusable so the tooltip saying why is reachable by keyboard.
              aria-disabled={!enabled}
              className={enabled ? undefined : 'opacity-50'}
              aria-describedby={reason ? `${action.id}-why` : undefined}
              onClick={() => (enabled ? void action.run?.(context, ui) : undefined)}
            >
              <Icon aria-hidden />
              {label}
            </Button>
          );
        return reason ? (
          <Tooltip key={action.id}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent id={`${action.id}-why`}>{t(reason as never)}</TooltipContent>
          </Tooltip>
        ) : (
          <React.Fragment key={action.id}>{button}</React.Fragment>
        );
      })}
    </div>
  );
}
