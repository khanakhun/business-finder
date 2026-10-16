'use client';

import type { CrmState } from '@bf/contracts';
import { Avatar, AvatarFallback, AvatarImage } from '@bf/ui/components/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { useTranslations } from 'next-intl';
import { apiClient } from '@/lib/api.ts';
import { useBusinessMutation, useTeammates } from '../api.ts';

const NOBODY = '__nobody__';

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

/** A teammate's avatar (their initials when they have no picture). */
export function TeammateAvatar({
  name,
  image,
  className,
}: {
  readonly name: string;
  readonly image: string | null;
  readonly className?: string;
}) {
  return (
    <Avatar className={className ?? 'size-6'}>
      {image ? <AvatarImage src={image} alt="" /> : null}
      <AvatarFallback className="text-[10px]">{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

export function OwnerSelect({
  businessId,
  ownerUserId,
  disabled,
}: {
  readonly businessId: string;
  readonly ownerUserId: string | null;
  readonly disabled: boolean;
}) {
  const t = useTranslations('business.owner');
  const teammates = useTeammates();
  const assign = useBusinessMutation(
    businessId,
    async (owner: string | null) =>
      (
        await apiClient().PUT('/v1/businesses/{id}/owner', {
          params: { path: { id: businessId } },
          body: { ownerUserId: owner },
        })
      ).data as CrmState,
  );
  return (
    <Select
      value={ownerUserId ?? NOBODY}
      disabled={disabled || assign.isPending}
      onValueChange={(value) => assign.mutate(value === NOBODY ? null : value)}
    >
      <SelectTrigger size="sm" aria-label={t('label')} className="min-w-40">
        <SelectValue placeholder={t('nobody')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NOBODY}>{t('nobody')}</SelectItem>
        {(teammates.data?.items ?? []).map((teammate) => (
          <SelectItem key={teammate.userId} value={teammate.userId}>
            <TeammateAvatar name={teammate.name} image={teammate.image} className="size-5" />
            {teammate.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
