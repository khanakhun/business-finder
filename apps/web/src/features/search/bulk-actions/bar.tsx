'use client';

import type { BusinessList, BusinessListPage, ListItemsResult, Permission } from '@bf/contracts';
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@bf/ui/components/tooltip';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DownloadIcon,
  KanbanIcon,
  LayoutTemplateIcon,
  ListPlusIcon,
  type LucideIcon,
  MailIcon,
  SendIcon,
  SparklesIcon,
  TagsIcon,
  XIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { publicEnv } from '@/lib/public-env.ts';
import { useSession } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { ADD_TO_LIST_DIALOG, registerDefaultBulkActions } from './defaults.ts';
import {
  type BulkActionUi,
  type BulkSelection,
  bulkActionsFor,
  bulkDialog,
  registerBulkDialog,
} from './registry.ts';

const ICONS: Record<string, LucideIcon> = {
  'list-plus': ListPlusIcon,
  download: DownloadIcon,
  tags: TagsIcon,
  kanban: KanbanIcon,
  'layout-template': LayoutTemplateIcon,
  mail: MailIcon,
  send: SendIcon,
  sparkles: SparklesIcon,
};

/** Starts a download of an API path (the session cookie travels with a top-level navigation). */
export function downloadFromApi(path: string, query: Readonly<Record<string, string | string[]>>): void {
  const url = new URL(path, publicEnv().apiUrl);
  for (const [key, value] of Object.entries(query)) {
    for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
  }
  const link = document.createElement('a');
  link.href = url.toString();
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

function AddToListDialog({
  ids,
  onClose,
}: {
  readonly ids: readonly string[];
  readonly onClose: (result: ListItemsResult | null) => void;
}) {
  const t = useTranslations('search.lists');
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  const [name, setName] = React.useState('');
  const lists = useQuery({
    queryKey: queryKeys.search.lists(),
    queryFn: async () =>
      (await apiClient().GET('/v1/lists', { params: { query: { limit: 200 } } })).data as BusinessListPage,
  });
  const add = useMutation({
    mutationFn: async (list: BusinessList | { name: string }) => {
      const target =
        'id' in list
          ? list
          : ((await apiClient().POST('/v1/lists', { body: { name: list.name } })).data as BusinessList);
      const result = (
        await apiClient().POST('/v1/lists/{id}/items', {
          params: { path: { id: target.id } },
          body: { businessIds: [...ids] },
        })
      ).data as ListItemsResult;
      return { result, target };
    },
    onSuccess: async ({ result, target }) => {
      await client.invalidateQueries({ queryKey: queryKeys.search.lists() });
      const toast = await getToast();
      toast.success(t('added', { added: result.changed, list: target.name }));
      if (result.notTracked.length > 0) toast.message(t('notTracked', { count: result.notTracked.length }));
      onClose(result);
    },
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose(null))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('choose')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-64 space-y-1 overflow-auto">
          {(lists.data?.items ?? []).map((list) => (
            <li key={list.id}>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-between"
                disabled={add.isPending}
                onClick={() => add.mutate(list)}
              >
                <span>{list.name}</span>
                <span className="text-xs text-muted-foreground">{t('items', { count: list.itemCount })}</span>
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) add.mutate({ name: name.trim() });
          }}
        >
          <div className="flex-1 space-y-1">
            <Label htmlFor="new-list">{t('new')}</Label>
            <Input id="new-list" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button type="submit" disabled={!name.trim() || add.isPending}>
            {t('create')}
          </Button>
        </form>
        <DialogFooter />
      </DialogContent>
    </Dialog>
  );
}

function ActiveDialog({
  id,
  props,
  onClose,
}: {
  readonly id: string;
  readonly props: Record<string, unknown>;
  readonly onClose: (result: unknown) => void;
}) {
  const Dialog_ = bulkDialog(id);
  return Dialog_ ? <Dialog_ props={props} onClose={onClose} /> : null;
}

registerBulkDialog(ADD_TO_LIST_DIALOG, ({ props, onClose }) => (
  <AddToListDialog ids={(props.ids as string[]) ?? []} onClose={onClose} />
));

/** The bar of bulk actions over the selection (or every result for actions that allow it). */
export function BulkBar({
  selection,
  onClear,
}: {
  readonly selection: BulkSelection;
  readonly onClear: () => void;
}) {
  const t = useTranslations();
  const me = useSession();
  const router = useRouter();
  const [dialog, setDialog] = React.useState<{
    id: string;
    props: Record<string, unknown>;
    resolve: (value: unknown) => void;
  } | null>(null);
  React.useEffect(registerDefaultBulkActions, []);
  const permissions = React.useMemo(() => new Set<Permission>(me.permissions), [me.permissions]);
  const actions = bulkActionsFor({ selection, permissions }).filter((a) => a.visible);
  const ui: BulkActionUi = {
    dialog: <T,>(id: string, props: Record<string, unknown> = {}) =>
      new Promise<T | null>((resolve) =>
        setDialog({ id, props, resolve: resolve as (value: unknown) => void }),
      ),
    download: downloadFromApi,
    navigate: (href) => router.push(href),
  };
  const close = (value: unknown) => {
    dialog?.resolve(value);
    setDialog(null);
  };
  const count = selection.ids.length;
  return (
    <TooltipProvider>
      <div
        role="toolbar"
        aria-label={t('search.bulk.selected', { count })}
        className="flex flex-wrap items-center gap-1.5 rounded-lg border border-lagoon/40 bg-lagoon-wash px-2 py-1.5"
      >
        {count > 0 ? (
          <>
            <span className="px-1 text-sm font-medium" aria-live="polite">
              {t('search.bulk.selected', { count })}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onClear}
              aria-label={t('search.bulk.clear')}
            >
              <XIcon aria-hidden />
            </Button>
          </>
        ) : null}
        {actions.map(({ action, enabled, reason }) => {
          const Icon = ICONS[action.icon] ?? ListPlusIcon;
          const label =
            action.id === 'search.export' && count === 0
              ? t('search.bulk.exportAll')
              : t(action.labelKey as never);
          const button = (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              // aria-disabled (not disabled) keeps it focusable, so the tooltip explaining why can be reached.
              aria-disabled={!enabled}
              className={enabled ? undefined : 'opacity-50'}
              aria-describedby={reason ? `${action.id}-why` : undefined}
              onClick={() => (enabled ? void action.run({ selection, permissions }, ui) : undefined)}
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
        {dialog ? <ActiveDialog id={dialog.id} props={dialog.props} onClose={close} /> : null}
      </div>
    </TooltipProvider>
  );
}
