'use client';

import { Alert, AlertDescription } from '@bf/ui/components/alert';
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
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { registerBulkAction, registerBulkDialog } from '@/features/search/bulk-actions/registry.ts';
import { queryKeys } from '@/lib/api.ts';
import { getToast } from '@/lib/toast.tsx';
import { enrichMany, useEnrichmentEstimate } from './api.ts';

// Bulk "Enrich" on search results (BF-027): an estimate against the monthly budget, then one run per business.

export const BULK_ENRICH_DIALOG = 'enrichment.bulk-enrich';
/** The API's limit per bulk request. */
const MAX_IDS = 500;

function BulkEnrichDialog({
  props,
  onClose,
}: {
  readonly props: Record<string, unknown>;
  readonly onClose: (r: unknown) => void;
}) {
  const t = useTranslations('enrichment');
  const format = useFormatter();
  const ids = (props.ids as string[]) ?? [];
  const estimate = useEnrichmentEstimate(ids);
  const client = useQueryClient();
  // One key for this dialog: pressing Enrich again (or a retry) does not start runs twice.
  const [key] = React.useState(() => `bulk-${crypto.randomUUID()}`);
  const usd = (value: number) =>
    format.number(value, { style: 'currency', currency: 'USD', maximumFractionDigits: 3 });
  const start = useMutation({
    mutationFn: () => enrichMany(ids, key),
    onSuccess: async (result) => {
      const toast = await getToast();
      if (result.rejected.length > 0)
        toast.message(t('bulk.partial', { started: result.runs.length, rejected: result.rejected.length }));
      else toast.success(t('bulk.started', { count: result.runs.length }));
      await client.invalidateQueries({ queryKey: queryKeys.search.all });
      onClose({ done: result.runs.length });
    },
    onError: async () => (await getToast()).error(t('bulk.failed')),
  });
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose(null))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('bulk.title', { count: ids.length })}</DialogTitle>
          <DialogDescription>{t('bulk.description')}</DialogDescription>
        </DialogHeader>
        {estimate.isLoading ? (
          <div className="space-y-2" role="status">
            <span className="sr-only">{t('bulk.estimating')}</span>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : estimate.data ? (
          <div className="space-y-3 text-sm">
            <ul className="space-y-1">
              {estimate.data.steps
                .filter((step) => step.willRun > 0)
                .map((step) => (
                  <li key={step.step}>
                    {t('bulk.willRun', { step: t(`steps.${step.step}` as never), count: step.willRun })}
                  </li>
                ))}
            </ul>
            <p className="font-medium">{t('bulk.cost', { cost: usd(estimate.data.totalCostUsd) })}</p>
            <p className="text-muted-foreground">
              {estimate.data.budget.remainingUsd === null
                ? t('bulk.noBudget')
                : t('bulk.budget', { left: usd(estimate.data.budget.remainingUsd) })}
            </p>
            {estimate.data.withinBudget ? null : (
              <Alert variant="destructive">
                <AlertDescription>{t('bulk.overBudget')}</AlertDescription>
              </Alert>
            )}
          </div>
        ) : estimate.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{t('bulk.estimateFailed')}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onClose(null)}>
            {t('bulk.cancel')}
          </Button>
          <Button
            type="button"
            disabled={start.isPending || estimate.isLoading || estimate.isError}
            onClick={() => start.mutate()}
          >
            {t('bulk.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

let registered = false;

/** Registers the bulk Enrich action and its dialog (idempotent). */
export function registerEnrichmentBulkAction(): void {
  if (registered) return;
  registered = true;
  registerBulkDialog(BULK_ENRICH_DIALOG, BulkEnrichDialog);
  registerBulkAction({
    id: 'enrichment.enrich',
    labelKey: 'search.bulk.enrich',
    icon: 'sparkles',
    permission: 'business:write',
    order: 45,
    disabledReason: (context) => (context.selection.ids.length > MAX_IDS ? 'enrichment.bulk.tooMany' : null),
    run: async (context, ui) => ui.dialog(BULK_ENRICH_DIALOG, { ids: context.selection.ids }),
  });
}
