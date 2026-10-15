'use client';

import type { CrmState } from '@bf/contracts';
import { Label } from '@bf/ui/components/label';
import { Switch } from '@bf/ui/components/switch';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { apiClient } from '@/lib/api.ts';
import { useBusinessMutation } from '../api.ts';
import { ReasonDialog } from './status-menu.tsx';

/** Do-not-contact: on needs a reason (compliance suppresses outreach, BF-049); off is one click. */
export function DoNotContactSwitch({
  businessId,
  value,
  reason,
  disabled,
}: {
  readonly businessId: string;
  readonly value: boolean;
  readonly reason: string | null;
  readonly disabled: boolean;
}) {
  const t = useTranslations('business.doNotContact');
  const [asking, setAsking] = React.useState(false);
  const id = React.useId();
  const set = useBusinessMutation(
    businessId,
    async (change: { doNotContact: boolean; reason?: string }) =>
      (
        await apiClient().PUT('/v1/businesses/{id}/do-not-contact', {
          params: { path: { id: businessId } },
          body: change,
        })
      ).data as CrmState,
    { success: (_result, change) => (change.doNotContact ? t('marked') : t('cleared')) },
  );
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={id}
        checked={value}
        disabled={disabled || set.isPending}
        aria-describedby={reason ? `${id}-reason` : undefined}
        onCheckedChange={(checked) => (checked ? setAsking(true) : set.mutate({ doNotContact: false }))}
      />
      <Label htmlFor={id} className={value ? 'text-reef' : undefined}>
        {t('label')}
      </Label>
      {value && reason ? (
        <span id={`${id}-reason`} className="max-w-56 truncate text-sm text-muted-foreground" title={reason}>
          {reason}
        </span>
      ) : null}
      <ReasonDialog
        open={asking}
        title={t('title')}
        description={t('description')}
        confirm={t('confirm')}
        pending={set.isPending}
        onCancel={() => setAsking(false)}
        onConfirm={(text) =>
          set.mutate({ doNotContact: true, reason: text }, { onSettled: () => setAsking(false) })
        }
      />
    </div>
  );
}
