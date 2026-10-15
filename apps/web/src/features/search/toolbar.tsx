'use client';

import type { SavedSearch, SavedSearchPage } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@bf/ui/components/dropdown-menu';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { cn } from '@bf/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookmarkIcon, ChevronDownIcon, type LucideIcon, MapIcon, RadarIcon, TableIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useSearchState } from './hooks.tsx';
import { fromSavedFilters, MODES, SORTS, toSavedFilters } from './url-state.ts';

export function SaveSearchDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('search.saved');
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  const [state] = useSearchState();
  const [name, setName] = React.useState('');
  const [shared, setShared] = React.useState(false);
  const [notify, setNotify] = React.useState(false);
  React.useEffect(() => {
    if (open) setName(state.prompt ?? '');
  }, [open, state.prompt]);
  const save = useMutation({
    mutationFn: async () =>
      (
        await apiClient().POST('/v1/saved-searches', {
          body: {
            name: name.trim(),
            ...(state.prompt ? { prompt: state.prompt } : {}),
            filters: toSavedFilters(state),
            ...(state.sort ? { sort: state.sort } : {}),
            visibility: shared ? 'workspace' : 'private',
            notifyNew: notify,
          } as never,
        })
      ).data as SavedSearch,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.search.saved() });
      (await getToast()).success(t('created'));
      onOpenChange(false);
    },
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('save')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="saved-name">{t('name')}</Label>
            <Input
              id="saved-name"
              value={name}
              maxLength={120}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{t('visibility')}</legend>
            {(['private', 'workspace'] as const).map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="visibility"
                  className="accent-lagoon"
                  checked={shared === (value === 'workspace')}
                  onChange={() => setShared(value === 'workspace')}
                />
                {t(value)}
              </label>
            ))}
          </fieldset>
          <div className="flex items-center gap-2 text-sm">
            <Checkbox
              id="saved-notify"
              checked={notify}
              onCheckedChange={(checked) => setNotify(checked === true)}
            />
            <Label htmlFor="saved-notify" className="font-normal">
              {t('notify')}
            </Label>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SavedSearchesMenu() {
  const t = useTranslations('search.toolbar');
  const [, setState] = useSearchState();
  const saved = useQuery({
    queryKey: queryKeys.search.saved(),
    queryFn: async () =>
      (await apiClient().GET('/v1/saved-searches', { params: { query: { limit: 50 } } }))
        .data as SavedSearchPage,
  });
  const open = async (search: SavedSearch) => {
    await apiClient().POST('/v1/saved-searches/{id}/run', { params: { path: { id: search.id } } });
    const filters = fromSavedFilters(search.filters as Record<string, string | string[]>);
    const reset = Object.fromEntries(Object.keys(filters).map((k) => [k, null]));
    await setState({ ...reset, ...filters, prompt: search.prompt, sort: search.sort, run: null });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="ghost">
          <BookmarkIcon aria-hidden />
          {t('saved')}
          <ChevronDownIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {(saved.data?.items ?? []).length === 0 ? (
          <DropdownMenuItem disabled>{t('noSaved')}</DropdownMenuItem>
        ) : (
          saved.data?.items.map((search) => (
            <DropdownMenuItem key={search.id} onSelect={() => void open(search)}>
              {search.name}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/search/saved">{t('manageSaved')}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A segmented control built on native radios (arrow keys move, one tab stop). */
function Segmented<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
}: {
  readonly name: string;
  readonly legend: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string; readonly icon?: LucideIcon }>;
  readonly onChange: (value: T) => void;
}) {
  return (
    <fieldset className="inline-flex rounded-md border border-border p-0.5">
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <label
            key={option.value}
            className={cn(
              'inline-flex cursor-pointer items-center gap-1 rounded px-2.5 py-1 text-sm',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-lagoon',
              value === option.value ? 'bg-lagoon text-primary-foreground' : 'hover:bg-accent',
            )}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {Icon ? <Icon aria-hidden className="size-4" /> : null}
            {option.label}
          </label>
        );
      })}
    </fieldset>
  );
}

/** Result count, look-in mode, sort, table/map, saved searches and discovery. */
export function SearchToolbar({
  count,
  more,
  onSave,
  onDiscover,
}: {
  readonly count: number;
  readonly more: boolean;
  readonly onSave: () => void;
  readonly onDiscover: () => void;
}) {
  const t = useTranslations('search.toolbar');
  const [state, setState] = useSearchState();
  const canDiscover = usePermission('discovery:run');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="mr-auto text-sm font-medium" aria-live="polite">
        {more ? t('resultsMore', { count }) : t('results', { count })}
      </p>
      <Segmented
        name="search-mode"
        legend={t('mode')}
        value={state.mode}
        options={MODES.map((mode) => ({ value: mode, label: t(`modes.${mode}`) }))}
        onChange={(mode) => {
          void setState({ mode });
          if (mode !== 'listings' && canDiscover) onDiscover();
        }}
      />
      <Select
        value={state.sort ?? 'relevance'}
        onValueChange={(sort) =>
          void setState({ sort: sort === 'relevance' ? null : (sort as (typeof SORTS)[number]) })
        }
      >
        <SelectTrigger size="sm" aria-label={t('sort')} className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORTS.map((sort) => (
            <SelectItem key={sort} value={sort}>
              {t(`sorts.${sort}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Segmented
        name="search-view"
        legend={t('view')}
        value={state.view}
        options={[
          { value: 'table' as const, label: t('table'), icon: TableIcon },
          { value: 'map' as const, label: t('map'), icon: MapIcon },
        ]}
        onChange={(view) => void setState({ view })}
      />
      <SavedSearchesMenu />
      <Button type="button" size="sm" variant="outline" onClick={onSave}>
        {t('save')}
      </Button>
      {canDiscover ? (
        <Button type="button" size="sm" onClick={onDiscover}>
          <RadarIcon aria-hidden />
          {t('discover')}
        </Button>
      ) : null}
    </div>
  );
}
