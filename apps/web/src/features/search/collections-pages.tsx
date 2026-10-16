'use client';

import type { BusinessList, BusinessListPage, SavedSearch, SavedSearchPage } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { fromSavedFilters, serializeSearch } from './url-state.ts';

function Rows({ children }: { readonly children: React.ReactNode }) {
  return <ul className="divide-y rounded-lg border bg-surface">{children}</ul>;
}

function Loading() {
  return (
    <div className="space-y-2" aria-busy>
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

/** `/search/saved`: open, see new matches, delete (creator only). */
export function SavedSearchesPage() {
  const t = useTranslations('search.saved');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const errorLabels = useErrorLabels();
  const client = useQueryClient();
  const saved = useQuery({
    queryKey: queryKeys.search.saved(),
    queryFn: async () =>
      (await apiClient().GET('/v1/saved-searches', { params: { query: { limit: 200 } } }))
        .data as SavedSearchPage,
  });
  const remove = useMutation({
    mutationFn: async (search: SavedSearch) =>
      apiClient().DELETE('/v1/saved-searches/{id}', { params: { path: { id: search.id } } }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.search.saved() });
      (await getToast()).success(t('deleted'));
    },
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });
  if (saved.isError) {
    return (
      <ErrorState
        problem={toProblemLike(saved.error, t('title'))}
        labels={errorLabels}
        onRetry={() => void saved.refetch()}
      />
    );
  }
  if (!saved.data) return <Loading />;
  if (saved.data.items.length === 0) {
    return (
      <EmptyState
        title={t('empty')}
        description={t('emptyBody')}
        action={
          <Button asChild>
            <Link href="/search">{t('open')}</Link>
          </Button>
        }
      />
    );
  }
  return (
    <Rows>
      {saved.data.items.map((search) => {
        const href = serializeSearch('/search', {
          ...fromSavedFilters(search.filters as Record<string, string | string[]>),
          prompt: search.prompt,
          sort: search.sort,
        });
        return (
          <li key={search.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {search.name}{' '}
                {search.visibility === 'workspace' ? <Badge variant="secondary">{t('shared')}</Badge> : null}
              </p>
              <p className="truncate text-sm text-muted-foreground">
                {search.prompt ?? ''}
                {search.lastRunAt
                  ? ` ${t('lastRun', { date: format.dateTime(new Date(search.lastRunAt), { dateStyle: 'medium' }) })}`
                  : ` ${t('neverRun')}`}
              </p>
            </div>
            <Button asChild size="sm">
              <Link
                href={href}
                onClick={() =>
                  void apiClient().POST('/v1/saved-searches/{id}/run', {
                    params: { path: { id: search.id } },
                  })
                }
              >
                <SearchIcon aria-hidden />
                {t('open')}
              </Link>
            </Button>
            {search.mine ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`${t('delete')}: ${search.name}`}
                onClick={() => {
                  if (window.confirm(t('deleteConfirm', { name: search.name }))) remove.mutate(search);
                }}
              >
                <Trash2Icon aria-hidden />
              </Button>
            ) : null}
          </li>
        );
      })}
    </Rows>
  );
}

/** `/lists`: the workspace's lists, create, delete; a list opens as a search filtered on it. */
export function ListsPage() {
  const t = useTranslations('search.lists');
  const errorMessage = useErrorMessage();
  const errorLabels = useErrorLabels();
  const client = useQueryClient();
  const canWrite = usePermission('business:write');
  const [name, setName] = React.useState('');
  const lists = useQuery({
    queryKey: queryKeys.search.lists(),
    queryFn: async () =>
      (await apiClient().GET('/v1/lists', { params: { query: { limit: 200 } } })).data as BusinessListPage,
  });
  const create = useMutation({
    mutationFn: async () =>
      (await apiClient().POST('/v1/lists', { body: { name: name.trim() } })).data as BusinessList,
    onSuccess: async () => {
      setName('');
      await client.invalidateQueries({ queryKey: queryKeys.search.lists() });
    },
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });
  const remove = useMutation({
    mutationFn: async (list: BusinessList) =>
      apiClient().DELETE('/v1/lists/{id}', { params: { path: { id: list.id } } }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.search.lists() });
      (await getToast()).success(t('deleted'));
    },
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });
  return (
    <div className="space-y-4">
      {canWrite ? (
        <form
          className="flex max-w-md items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <div className="flex-1 space-y-1">
            <Label htmlFor="list-name">{t('name')}</Label>
            <Input id="list-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            {t('create')}
          </Button>
        </form>
      ) : null}
      {lists.isError ? (
        <ErrorState
          problem={toProblemLike(lists.error, t('title'))}
          labels={errorLabels}
          onRetry={() => void lists.refetch()}
        />
      ) : !lists.data ? (
        <Loading />
      ) : lists.data.items.length === 0 ? (
        <EmptyState title={t('empty')} description={t('emptyBody')} />
      ) : (
        <Rows>
          {lists.data.items.map((list) => (
            <li key={list.id} className="flex items-center gap-3 px-4 py-3">
              <ListIcon aria-hidden className="size-4 text-lagoon" />
              <div className="min-w-0 flex-1">
                <Link href={`/lists/${list.id}`} className="font-medium hover:underline">
                  {list.name}
                </Link>
                <p className="text-sm text-muted-foreground">{t('items', { count: list.itemCount })}</p>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={serializeSearch('/search', { list: list.id })}>{t('open')}</Link>
              </Button>
              {canWrite ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`${t('delete')}: ${list.name}`}
                  onClick={() => {
                    if (window.confirm(t('deleteConfirm', { name: list.name }))) remove.mutate(list);
                  }}
                >
                  <Trash2Icon aria-hidden />
                </Button>
              ) : null}
            </li>
          ))}
        </Rows>
      )}
    </div>
  );
}
