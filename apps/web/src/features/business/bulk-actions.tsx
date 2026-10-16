'use client';

import type { BulkResult, PipelineStatus } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Textarea } from '@bf/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { registerBulkAction, registerBulkDialog } from '@/features/search/bulk-actions/registry.ts';
import { STATUSES } from '@/features/search/url-state.ts';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { getToast } from '@/lib/toast.tsx';
import { useCrmErrorMessage } from './api.ts';
import { parseTags } from './tags.ts';

// Bulk tags and pipeline status on search results (BF-024): they replace BF-023's placeholders by id.

export const BULK_TAGS_DIALOG = 'crm.bulk-tags';
export const BULK_STATUS_DIALOG = 'crm.bulk-status';
/** The API's limit per bulk request. */
const MAX_IDS = 1_000;
const REASON_STATUSES: readonly PipelineStatus[] = ['lost', 'disqualified'];

function useBulk<B>(
  path: '/v1/businesses/bulk/status' | '/v1/businesses/bulk/tags',
  onClose: (r: unknown) => void,
) {
  const t = useTranslations('search.bulk');
  const client = useQueryClient();
  const message = useCrmErrorMessage();
  return useMutation({
    mutationFn: async (body: B) => (await apiClient().POST(path, { body: body as never })).data as BulkResult,
    onSuccess: async (result) => {
      const toast = await getToast();
      if (result.failed.length > 0)
        toast.message(t('partial', { done: result.changed, failed: result.failed.length }));
      else toast.success(t('done', { count: result.changed + result.unchanged }));
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.search.all }),
        client.invalidateQueries({ queryKey: queryKeys.crm.all }),
        client.invalidateQueries({ queryKey: queryKeys.business.all }),
      ]);
      onClose({
        done: result.changed,
        failed: result.failed.map((f) => ({ id: f.businessId, reason: f.code })),
      });
    },
    onError: async (error) => (await getToast()).error(message(error)),
  });
}

function BulkTagsDialog({
  props,
  onClose,
}: {
  readonly props: Record<string, unknown>;
  readonly onClose: (r: unknown) => void;
}) {
  const t = useTranslations('business.bulk');
  const ids = (props.ids as string[]) ?? [];
  const [add, setAdd] = React.useState('');
  const [remove, setRemove] = React.useState('');
  const bulk = useBulk<{ businessIds: string[]; add: string[]; remove: string[] }>(
    '/v1/businesses/bulk/tags',
    onClose,
  );
  const changes = parseTags(add).length + parseTags(remove).length;
  const id = React.useId();
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose(null))}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (changes > 0)
              bulk.mutate({ businessIds: ids, add: parseTags(add), remove: parseTags(remove) });
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('tagsTitle', { count: ids.length })}</DialogTitle>
            <DialogDescription>{t('tagsDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-add`}>{t('addTags')}</Label>
            <Input id={`${id}-add`} value={add} onChange={(event) => setAdd(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-remove`}>{t('removeTags')}</Label>
            <Input id={`${id}-remove`} value={remove} onChange={(event) => setRemove(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onClose(null)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={changes === 0 || bulk.isPending}>
              {t('apply')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BulkStatusDialog({
  props,
  onClose,
}: {
  readonly props: Record<string, unknown>;
  readonly onClose: (r: unknown) => void;
}) {
  const t = useTranslations('business.bulk');
  const label = useTranslations('search.status');
  const ids = (props.ids as string[]) ?? [];
  const [status, setStatus] = React.useState<PipelineStatus>('qualified');
  const [reason, setReason] = React.useState('');
  const bulk = useBulk<{ businessIds: string[]; status: PipelineStatus; reason?: string }>(
    '/v1/businesses/bulk/status',
    onClose,
  );
  const needsReason = REASON_STATUSES.includes(status);
  const id = React.useId();
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose(null))}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (needsReason && !reason.trim()) return;
            bulk.mutate({ businessIds: ids, status, ...(needsReason ? { reason: reason.trim() } : {}) });
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('statusTitle', { count: ids.length })}</DialogTitle>
            <DialogDescription>{t('statusDescription')}</DialogDescription>
          </DialogHeader>
          <Select value={status} onValueChange={(value) => setStatus(value as PipelineStatus)}>
            <SelectTrigger aria-label={t('status')} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((option) => (
                <SelectItem key={option} value={option}>
                  {label(option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {needsReason ? (
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-reason`}>{t('reason')}</Label>
              <Textarea
                id={`${id}-reason`}
                value={reason}
                rows={2}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onClose(null)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={bulk.isPending || (needsReason && !reason.trim())}>
              {t('apply')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

let registered = false;

/** Registers the CRM bulk actions and their dialogs (idempotent). */
export function registerCrmBulkActions(): void {
  if (registered) return;
  registered = true;
  registerBulkDialog(BULK_TAGS_DIALOG, BulkTagsDialog);
  registerBulkDialog(BULK_STATUS_DIALOG, BulkStatusDialog);
  registerBulkAction({
    id: 'crm.set-tags',
    labelKey: 'search.bulk.tags',
    icon: 'tags',
    permission: 'business:write',
    order: 30,
    disabledReason: (context) => (context.selection.ids.length > MAX_IDS ? 'business.bulk.tooMany' : null),
    run: async (context, ui) => ui.dialog(BULK_TAGS_DIALOG, { ids: context.selection.ids }),
  });
  registerBulkAction({
    id: 'crm.set-status',
    labelKey: 'search.bulk.status',
    icon: 'kanban',
    permission: 'business:write',
    order: 40,
    disabledReason: (context) => (context.selection.ids.length > MAX_IDS ? 'business.bulk.tooMany' : null),
    run: async (context, ui) => ui.dialog(BULK_STATUS_DIALOG, { ids: context.selection.ids }),
  });
}
