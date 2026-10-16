'use client';

import type { CategoryMapping, CategoryMappingPage, CategoryNode, CategoryTree } from '@bf/contracts';
import { Alert, AlertDescription } from '@bf/ui/components/alert';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { CategoryPicker, type CategoryPickerNode } from '@bf/ui/components/category-picker';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@bf/ui/components/table';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRightIcon, TagsIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { Forbidden } from './forbidden.tsx';
import { SettingsSection } from './section.tsx';

type Locale = 'en' | 'fr';
const PAGE_SIZE = 50;

/** `CategoryNode` tree → `CategoryPicker` nodes (other-language label as a search keyword). */
export function toPickerTree(nodes: readonly CategoryNode[], locale: Locale): CategoryPickerNode[] {
  return nodes.map((node) => ({
    id: node.id,
    label: node.label,
    keywords: [node.labels[locale === 'en' ? 'fr' : 'en'], node.slug.replace(/_/g, ' ')],
    children: toPickerTree(node.children, locale),
  }));
}

export function useCategoryTree(locale: Locale, enabled = true) {
  return useQuery({
    queryKey: queryKeys.taxonomy.tree(locale),
    queryFn: async () =>
      (await apiClient().GET('/v1/categories', { params: { query: { locale } } })).data as CategoryTree,
    staleTime: 10 * 60_000,
    enabled,
  });
}

/** `/settings/taxonomy`: the review queue of LLM-proposed provider mappings, and the category tree. */
export function TaxonomySettings() {
  const t = useTranslations('taxonomy');
  const canManage = usePermission('settings:manage');
  const locale = useLocale() as Locale;
  const tree = useCategoryTree(locale, canManage);
  if (!canManage) return <Forbidden />;
  return (
    <div className="grid gap-6">
      <SettingsSection id="taxonomy-review" title={t('reviewTitle')} description={t('reviewDescription')}>
        <MappingReview locale={locale} tree={tree.data} />
      </SettingsSection>
      <SettingsSection id="taxonomy-tree" title={t('treeTitle')} description={t('treeDescription')}>
        {tree.isError ? (
          <TreeError error={tree.error} onRetry={() => void tree.refetch()} />
        ) : tree.data ? (
          <CategoryTreeView nodes={tree.data.items} />
        ) : (
          <Skeleton className="h-64" />
        )}
      </SettingsSection>
    </div>
  );
}

function TreeError({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  const t = useTranslations();
  return (
    <ErrorState
      problem={toProblemLike(error, t('errors.pageTitle'))}
      labels={useErrorLabels()}
      onRetry={onRetry}
    />
  );
}

function MappingReview({
  locale,
  tree,
}: {
  readonly locale: Locale;
  readonly tree: CategoryTree | undefined;
}) {
  const t = useTranslations();
  const labels = useErrorLabels();
  const query = useInfiniteQuery({
    queryKey: queryKeys.taxonomy.mappings('needs_review', locale),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await apiClient().GET('/v1/categories/mappings', {
          params: {
            query: {
              status: 'needs_review',
              locale,
              limit: PAGE_SIZE,
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        })
      ).data as CategoryMappingPage,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  if (query.isError) {
    return (
      <ErrorState
        problem={toProblemLike(query.error, t('errors.pageTitle'))}
        labels={labels}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <Skeleton className="h-40" />;
  const items = query.data.pages.flatMap((page) => page.items);
  const canReview = query.data.pages[0]?.canReview ?? false;
  return (
    <div className="grid gap-4">
      {!canReview ? (
        <Alert>
          <AlertDescription>{t('taxonomy.operatorsOnly')}</AlertDescription>
        </Alert>
      ) : null}
      {items.length === 0 ? (
        <EmptyState
          icon={<TagsIcon aria-hidden />}
          title={t('taxonomy.emptyTitle')}
          description={t('taxonomy.emptyDescription')}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('taxonomy.provider')}</TableHead>
              <TableHead>{t('taxonomy.proposed')}</TableHead>
              <TableHead className="text-end">{t('taxonomy.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((mapping) => (
              <MappingRow
                key={mapping.id}
                mapping={mapping}
                locale={locale}
                tree={tree}
                canReview={canReview}
              />
            ))}
          </TableBody>
        </Table>
      )}
      {query.hasNextPage ? (
        <Button
          variant="outline"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {t('taxonomy.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

function MappingRow({
  mapping,
  locale,
  tree,
  canReview,
}: {
  readonly mapping: CategoryMapping;
  readonly locale: Locale;
  readonly tree: CategoryTree | undefined;
  readonly canReview: boolean;
}) {
  const t = useTranslations('taxonomy');
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  const [reassignTo, setReassignTo] = React.useState<string[]>([]);
  const pickerTree = React.useMemo(() => (tree ? toPickerTree(tree.items, locale) : []), [tree, locale]);
  const review = useMutation({
    mutationFn: async (body: { action: 'approve' | 'reject' } | { action: 'reassign'; categoryId: string }) =>
      (
        await apiClient().PATCH('/v1/categories/mappings/{id}', {
          params: { path: { id: mapping.id }, query: { locale } },
          body,
        })
      ).data,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.taxonomy.all });
      (await getToast()).success(t('reviewed'));
    },
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });
  const disabled = !canReview || review.isPending;
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="font-medium">{mapping.providerLabel ?? mapping.providerKey}</div>
        <div className="text-sm text-muted-foreground">
          <Badge variant="outline" className="me-1">
            {mapping.provider}
          </Badge>
          <code>{mapping.providerKey}</code>
        </div>
      </TableCell>
      <TableCell className="align-top">
        <div>{mapping.categoryLabel}</div>
        <div className="text-sm text-muted-foreground">
          {t('confidence', { value: Math.round(mapping.confidence * 100) })}
          {mapping.rationale ? ` · ${mapping.rationale}` : ''}
        </div>
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <Button size="sm" onClick={() => review.mutate({ action: 'approve' })} disabled={disabled}>
              {t('approve')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => review.mutate({ action: 'reject' })}
              disabled={disabled}
            >
              {t('reject')}
            </Button>
          </div>
          {canReview ? (
            <div className="flex w-72 gap-2">
              <CategoryPicker
                tree={pickerTree}
                value={reassignTo}
                onChange={setReassignTo}
                multiple={false}
                disabled={disabled}
                labels={{
                  placeholder: t('reassignPlaceholder'),
                  searchPlaceholder: t('search'),
                  emptyText: t('noCategory'),
                  remove: (label) => t('remove', { label }),
                  more: (count) => t('more', { count }),
                  selected: t('selected'),
                }}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled || reassignTo.length === 0}
                onClick={() => {
                  const categoryId = reassignTo[0];
                  if (categoryId) review.mutate({ action: 'reassign', categoryId });
                }}
              >
                {t('reassign')}
              </Button>
            </div>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

function CategoryTreeView({ nodes }: { readonly nodes: readonly CategoryNode[] }) {
  return (
    <ul className="grid gap-1">
      {nodes.map((node) => (
        <li key={node.id}>
          {node.children.length > 0 ? (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1 rounded px-1 py-0.5 hover:bg-muted">
                <ChevronRightIcon aria-hidden className="size-4 transition-transform group-open:rotate-90" />
                {node.label}
                <span className="text-xs text-muted-foreground">({node.children.length})</span>
              </summary>
              <div className="ms-5 mt-1 border-s ps-2">
                <CategoryTreeView nodes={node.children} />
              </div>
            </details>
          ) : (
            <span className="ms-5 block px-1 py-0.5 text-sm">{node.label}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
