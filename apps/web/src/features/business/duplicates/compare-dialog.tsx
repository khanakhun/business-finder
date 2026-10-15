'use client';

import type { BusinessDetail, PossibleDuplicate } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import type * as React from 'react';
import { useCategories } from '@/features/search/hooks.tsx';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { getToast } from '@/lib/toast.tsx';
import { useBusiness, useCrmErrorMessage } from '../api.ts';
import { SourceBadge } from '../provenance.tsx';

type Field = {
  readonly key: string;
  readonly label: string;
  readonly attribute?: string;
  readonly value: (business: BusinessDetail) => React.ReactNode;
};

/**
 * Side by side: the two businesses' facts with their sources and why they look alike. Keep one (the other is
 * merged into it, with its sources, notes, tasks and timeline) or say they are different businesses.
 */
export function CompareDialog({
  current,
  pair,
  onClose,
}: {
  readonly current: BusinessDetail;
  readonly pair: PossibleDuplicate;
  readonly onClose: () => void;
}) {
  const t = useTranslations('business.duplicates');
  const format = useFormatter();
  const router = useRouter();
  const client = useQueryClient();
  const message = useCrmErrorMessage();
  const { labels } = useCategories();
  const otherId = pair.businessA.id === current.id ? pair.businessB.id : pair.businessA.id;
  const other = useBusiness(otherId);
  const resolve = useMutation({
    mutationFn: async (body: { action: 'merge'; survivorId: string } | { action: 'dismiss' }) => {
      await apiClient().PATCH('/v1/businesses/possible-duplicates/{id}', {
        params: { path: { id: pair.id } },
        body: body as never,
      });
      return body;
    },
    onSuccess: async (body) => {
      const toast = await getToast();
      const leaving = body.action === 'merge' && body.survivorId !== current.id;
      // The page's own business was merged away: leave first, and never refetch it (it would 404).
      if (leaving) {
        router.push(`/businesses/${body.survivorId}`);
        client.removeQueries({ queryKey: ['business', current.id] });
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.business.all }),
        client.invalidateQueries({ queryKey: queryKeys.search.all }),
        client.invalidateQueries({ queryKey: queryKeys.crm.all }),
      ]);
      onClose();
      if (body.action === 'dismiss') {
        toast.success(t('dismissed'));
        return;
      }
      toast.success(t('merged'));
    },
    onError: async (error) => (await getToast()).error(message(error)),
  });

  const fields: Field[] = [
    { key: 'name', label: t('fields.name'), attribute: 'displayName', value: (b) => b.displayName },
    {
      key: 'category',
      label: t('fields.category'),
      value: (b) => (b.primaryCategoryId ? labels.get(b.primaryCategoryId)?.label : null),
    },
    { key: 'address', label: t('fields.address'), attribute: 'address', value: (b) => b.formattedAddress },
    { key: 'phone', label: t('fields.phone'), attribute: 'primaryPhone', value: (b) => b.primaryPhone },
    { key: 'website', label: t('fields.website'), attribute: 'websiteUrl', value: (b) => b.websiteUrl },
    {
      key: 'rating',
      label: t('fields.rating'),
      value: (b) =>
        b.ratingAvg !== null
          ? `${format.number(b.ratingAvg, { maximumFractionDigits: 1 })} (${b.ratingCount ?? 0})`
          : null,
    },
  ];
  const columns = [current, other.data].filter((b): b is BusinessDetail => b !== undefined);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description', { score: Math.round(pair.score * 100) })}</DialogDescription>
        </DialogHeader>
        {pair.reasons.reasons.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground" aria-label={t('reasons')}>
            {pair.reasons.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
        {other.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-sm">
              <caption className="sr-only">{t('title')}</caption>
              <thead>
                <tr>
                  <th scope="col" className="w-28" />
                  {columns.map((business) => (
                    <th key={business.id} scope="col" className="px-2 pb-2 text-left font-semibold">
                      {business.id === current.id ? t('thisOne') : t('otherOne')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {fields.map((field) => (
                  <tr key={field.key}>
                    <th
                      scope="row"
                      className="py-2 pr-2 text-left align-top font-normal text-muted-foreground"
                    >
                      {field.label}
                    </th>
                    {columns.map((business) => (
                      <td key={business.id} className="px-2 py-2 align-top break-words">
                        <div>{field.value(business) ?? <span className="text-muted-foreground">—</span>}</div>
                        {field.attribute ? (
                          <SourceBadge provenance={business.attributes[field.attribute]} />
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate({ action: 'dismiss' })}
          >
            {t('dismiss')}
          </Button>
          <div className="flex flex-wrap gap-2">
            {columns.map((business) => (
              <Button
                key={business.id}
                type="button"
                variant={business.id === current.id ? 'default' : 'outline'}
                disabled={resolve.isPending || other.isLoading}
                onClick={() => resolve.mutate({ action: 'merge', survivorId: business.id })}
              >
                {t('keep', { name: business.displayName })}
              </Button>
            ))}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
