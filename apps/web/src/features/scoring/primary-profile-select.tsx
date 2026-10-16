'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { ConfirmDialog } from '@/components/settings/confirm-dialog.tsx';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useScoringProfiles, useSetPrimaryProfile } from './api.ts';
import { OFFER_ICON } from './score-badge.tsx';

// The listing's profile (BF-032): the workspace's primary profile fills the score column, the tier facet and the sort;
// `scoring:manage` switches it for the whole workspace (it recomputes), others see which one it is.

export function PrimaryProfileSelect() {
  const t = useTranslations('scoring.primary');
  const canManage = usePermission('scoring:manage');
  const profiles = useScoringProfiles();
  const setPrimary = useSetPrimaryProfile();
  const items = (profiles.data?.items ?? []).filter((profile) => !profile.archived);
  const [pending, setPending] = React.useState<{ id: string; name: string } | null>(null);
  const primary = items.find((profile) => profile.primary);
  if (!primary) return null;
  if (!canManage) {
    return <p className="text-sm text-muted-foreground">{t('readOnly', { name: primary.name })}</p>;
  }
  return (
    <>
      <Select
        value={primary.id}
        disabled={setPrimary.isPending}
        onValueChange={(profileId) => {
          const chosen = items.find((profile) => profile.id === profileId);
          if (chosen) setPending({ id: chosen.id, name: chosen.name });
        }}
      >
        <SelectTrigger size="sm" aria-label={t('label')} className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((profile) => {
            const Icon = OFFER_ICON[profile.offer];
            return (
              <SelectItem key={profile.id} value={profile.id}>
                <Icon aria-hidden className="size-4" />
                {profile.name}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={t('confirmTitle', { name: pending?.name ?? '' })}
        description={t('confirmDescription')}
        confirmLabel={t('confirm')}
        onConfirm={async () => {
          if (!pending) return;
          await setPrimary.mutateAsync(pending.id);
          (await getToast()).success(t('changed', { name: pending.name }));
        }}
      />
    </>
  );
}
