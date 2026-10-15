'use client';

import type { PipelineBoard, PipelineStatus } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { CategoryPicker } from '@bf/ui/components/category-picker';
import { ErrorState } from '@bf/ui/components/error-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { PageHeader } from '@bf/ui/components/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { TooltipProvider } from '@bf/ui/components/tooltip';
import { cn } from '@bf/ui/lib/utils';
import {
  type Announcements,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClockIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { parseAsString, useQueryStates } from 'nuqs';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { useCrmErrorMessage, useTeammates } from '@/features/business/api.ts';
import { TeammateAvatar } from '@/features/business/crm/owner-select.tsx';
import { ReasonDialog, StatusDot, StatusMenu } from '@/features/business/crm/status-menu.tsx';
import { useCategories } from '@/features/search/hooks.tsx';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { type Card, moveCard } from './move-card.ts';

const ALL = '__all__';
/** The working order, left to right: open stages, then the outcomes. */
const COLUMN_ORDER: readonly PipelineStatus[] = [
  'new',
  'qualified',
  'contacted',
  'engaged',
  'meeting',
  'proposal',
  'won',
  'lost',
  'disqualified',
];
const TIERS = ['A', 'B', 'C', 'X'] as const;
const filtersParsers = {
  owner: parseAsString,
  tag: parseAsString,
  category: parseAsString,
  tier: parseAsString,
};

function useBoard(filters: Readonly<Record<string, string>>) {
  return useQuery({
    queryKey: queryKeys.crm.board(filters),
    queryFn: async () =>
      (await apiClient().GET('/v1/pipeline', { params: { query: { ...filters, limit: 50 } as never } }))
        .data as PipelineBoard,
  });
}

function CardBody({ card, dragging = false }: { readonly card: Card; readonly dragging?: boolean }) {
  const t = useTranslations('pipeline');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { labels } = useCategories();
  const { byUser } = useTeammates();
  const owner = card.ownerUserId ? byUser.get(card.ownerUserId) : undefined;
  const due = card.nextTaskDueAt ? new Date(card.nextTaskDueAt) : null;
  const category = card.primaryCategoryId ? labels.get(card.primaryCategoryId)?.label : undefined;
  return (
    <div
      className={cn(
        'space-y-2 rounded-md border bg-card p-3 text-sm shadow-xs',
        dragging && 'rotate-1 border-lagoon shadow-md',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/businesses/${card.businessId}`}
          className="font-medium leading-snug hover:underline focus-visible:underline"
          draggable={false}
        >
          {card.displayName}
        </Link>
        {card.tier ? (
          <Badge
            variant="outline"
            className="shrink-0 tabular-nums"
            title={t('score', { score: card.score ?? 0 })}
          >
            {card.tier}
            {card.score !== null ? ` ${card.score}` : ''}
          </Badge>
        ) : null}
      </div>
      {category || card.locality ? (
        <p className="text-xs text-muted-foreground">
          {[category, card.locality].filter(Boolean).join(', ')}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        {due ? (
          <span className={cn('inline-flex items-center gap-1', due < now && 'font-medium text-buoy')}>
            <CalendarClockIcon aria-hidden className="size-3.5" />
            {format.relativeTime(due, now)}
          </span>
        ) : (
          <span />
        )}
        {owner ? <TeammateAvatar name={owner.name} image={owner.image} className="size-6" /> : null}
      </div>
    </div>
  );
}

function DraggableCard({
  card,
  status,
  canWrite,
}: {
  readonly card: Card;
  readonly status: PipelineStatus;
  readonly canWrite: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.businessId,
    data: { card, from: status },
    disabled: !canWrite,
  });
  return (
    <li
      ref={setNodeRef}
      className={cn('group relative', isDragging && 'opacity-40')}
      data-business-id={card.businessId}
    >
      {/* The pointer drags the card; the keyboard uses the status menu (dnd-kit's keyboard drag is not usable here). */}
      <div
        {...listeners}
        {...attributes}
        tabIndex={-1}
        role="presentation"
        className={canWrite ? 'cursor-grab' : undefined}
      >
        <CardBody card={card} />
      </div>
      {canWrite && card.allowedTransitions.length > 0 ? (
        <div className="absolute right-2 bottom-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
          <StatusMenu
            businessId={card.businessId}
            businessName={card.displayName}
            current={status}
            transitions={card.allowedTransitions}
            size="sm"
          />
        </div>
      ) : null}
    </li>
  );
}

function Column({
  status,
  count,
  cards,
  canWrite,
  dragging,
}: {
  readonly status: PipelineStatus;
  readonly count: number;
  readonly cards: readonly Card[];
  readonly canWrite: boolean;
  readonly dragging: { readonly card: Card; readonly from: PipelineStatus } | null;
}) {
  const t = useTranslations('pipeline');
  const label = useTranslations('search.status');
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const allowed = dragging ? dragging.card.allowedTransitions.some((tr) => tr.to === status) : false;
  const home = dragging?.from === status;
  return (
    <section
      ref={setNodeRef}
      aria-labelledby={`column-${status}`}
      data-status={status}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-lg border-t-2 border-transparent bg-surface-sunken/60',
        dragging && allowed && 'border-lagoon',
        dragging && !allowed && !home && 'opacity-50',
        isOver && allowed && 'bg-lagoon-wash',
      )}
    >
      <h2 id={`column-${status}`} className="flex items-center gap-2 px-3 pt-3 pb-2 text-sm font-semibold">
        <StatusDot status={status} />
        {label(status)}
        <span className="ml-auto font-normal tabular-nums text-muted-foreground">
          <span aria-hidden>{count}</span>
          <span className="sr-only">{t('count', { count })}</span>
        </span>
      </h2>
      <ul className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {cards.map((card) => (
          <DraggableCard key={card.businessId} card={card} status={status} canWrite={canWrite} />
        ))}
        {count > cards.length ? (
          <li className="px-1 text-xs">
            <Link href={`/search?status=${status}`} className="text-lagoon hover:underline">
              {t('more', { count: count - cards.length })}
            </Link>
          </li>
        ) : null}
        {count === 0 ? <li className="px-1 py-2 text-xs text-muted-foreground">{t('emptyColumn')}</li> : null}
      </ul>
    </section>
  );
}

/** The pipeline as a kanban (BF-024): drag a card to move it; only the moves the API allows are drop targets. */
export function PipelineBoardPage() {
  const t = useTranslations('pipeline');
  const status = useTranslations('search.status');
  const chips = useTranslations('search.chips');
  const errorLabels = useErrorLabels();
  const canWrite = usePermission('business:write');
  const client = useQueryClient();
  const message = useCrmErrorMessage();
  const teammates = useTeammates();
  const { picker } = useCategories();
  const [filters, setFilters] = useQueryStates(filtersParsers);
  const query = Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Record<string, string>;
  const key = queryKeys.crm.board(query);
  const board = useBoard(query);
  const [dragging, setDragging] = React.useState<{ card: Card; from: PipelineStatus } | null>(null);
  const [asking, setAsking] = React.useState<{ card: Card; to: PipelineStatus } | null>(null);

  const move = useMutation({
    mutationFn: async ({ card, to, reason }: { card: Card; to: PipelineStatus; reason?: string }) =>
      apiClient().POST('/v1/businesses/{id}/status', {
        params: { path: { id: card.businessId } },
        body: { status: to, ...(reason ? { reason } : {}) },
      }),
    onMutate: async ({ card, to }) => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<PipelineBoard>(key);
      if (previous) client.setQueryData(key, moveCard(previous, card.businessId, to));
      return { previous };
    },
    onSuccess: async (_result, { card, to }) =>
      (await getToast()).success(t('moved', { name: card.displayName, status: status(to) })),
    onError: async (error, _variables, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
      (await getToast()).error(message(error));
    },
    onSettled: async (_result, _error, { card }) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.crm.all }),
        client.invalidateQueries({ queryKey: ['business', card.businessId] }),
      ]);
    },
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const onDragStart = (event: DragStartEvent) =>
    setDragging(event.active.data.current as { card: Card; from: PipelineStatus });
  const onDragEnd = async (event: DragEndEvent) => {
    setDragging(null);
    const data = event.active.data.current as { card: Card; from: PipelineStatus } | undefined;
    const to = event.over?.id as PipelineStatus | undefined;
    if (!data || !to || to === data.from) return;
    const transition = data.card.allowedTransitions.find((tr) => tr.to === to);
    // The optimistic card offers no moves until the server answers: ignore it rather than claim a refusal.
    if (!transition && move.isPending) return;
    if (!transition) {
      (await getToast()).error(t('refused', { from: status(data.from), to: status(to) }));
      return;
    }
    if (transition.requiresReason) setAsking({ card: data.card, to });
    else move.mutate({ card: data.card, to });
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      t('a11y.picked', { name: (active.data.current as { card: Card }).card.displayName }),
    onDragOver: ({ over }) =>
      over ? t('a11y.over', { status: status(over.id as PipelineStatus) }) : undefined,
    onDragEnd: ({ over }) =>
      over ? t('a11y.dropped', { status: status(over.id as PipelineStatus) }) : t('a11y.cancelled'),
    onDragCancel: () => t('a11y.cancelled'),
  };

  return (
    <TooltipProvider>
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title={t('title')} description={t('description')} />
        <fieldset className="flex min-w-0 flex-wrap items-end gap-2 pb-4">
          <legend className="sr-only">{t('filters')}</legend>
          <Select
            value={filters.owner ?? ALL}
            onValueChange={(v) => void setFilters({ owner: v === ALL ? null : v })}
          >
            <SelectTrigger size="sm" aria-label={t('owner')} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('anyOwner')}</SelectItem>
              <SelectItem value="me">{t('mine')}</SelectItem>
              {(teammates.data?.items ?? []).map((teammate) => (
                <SelectItem key={teammate.userId} value={teammate.userId}>
                  {teammate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.tier ?? ALL}
            onValueChange={(v) => void setFilters({ tier: v === ALL ? null : v })}
          >
            <SelectTrigger size="sm" aria-label={t('tier')} className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('anyTier')}</SelectItem>
              {TIERS.map((tier) => (
                <SelectItem key={tier} value={tier}>
                  {t('tierValue', { tier })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label htmlFor="pipeline-category" className="sr-only">
            {t('category')}
          </Label>
          <CategoryPicker
            id="pipeline-category"
            className="w-56"
            multiple={false}
            tree={picker}
            value={filters.category ? [filters.category] : []}
            onChange={(value) => void setFilters({ category: value[0] ?? null })}
            labels={{
              placeholder: t('anyCategory'),
              searchPlaceholder: chips('categoriesSearch'),
              emptyText: chips('categoriesEmpty'),
              remove: (label) => chips('remove', { label }),
              more: (count) => chips('more', { count }),
              selected: chips('selected'),
            }}
          />
          <Input
            aria-label={t('tag')}
            placeholder={t('tag')}
            className="h-8 w-40"
            key={filters.tag ?? ''}
            defaultValue={filters.tag ?? ''}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void setFilters({ tag: event.currentTarget.value.trim() || null });
            }}
            onBlur={(event) => void setFilters({ tag: event.currentTarget.value.trim() || null })}
          />
        </fieldset>
        {board.isError ? (
          <ErrorState
            problem={toProblemLike(board.error, t('error'))}
            labels={errorLabels}
            onRetry={() => void board.refetch()}
          />
        ) : board.isLoading || !board.data ? (
          <div className="flex gap-3 overflow-hidden">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-96 w-72 shrink-0" />
            ))}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={onDragStart}
            onDragEnd={(event) => void onDragEnd(event)}
            onDragCancel={() => setDragging(null)}
            accessibility={{ announcements, screenReaderInstructions: { draggable: t('a11y.instructions') } }}
          >
            <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-3" aria-busy={board.isFetching}>
              {[...board.data.columns]
                .sort((a, b) => COLUMN_ORDER.indexOf(a.status) - COLUMN_ORDER.indexOf(b.status))
                .map((column) => (
                  <Column
                    key={column.status}
                    status={column.status}
                    count={column.count}
                    cards={column.cards}
                    canWrite={canWrite}
                    dragging={dragging}
                  />
                ))}
            </div>
            <DragOverlay dropAnimation={null}>
              {dragging ? <CardBody card={dragging.card} dragging /> : null}
            </DragOverlay>
          </DndContext>
        )}
        <ReasonDialog
          open={asking !== null}
          title={asking ? t('reasonTitle', { status: status(asking.to) }) : ''}
          description={t('reasonDescription')}
          confirm={asking ? t('moveTo', { status: status(asking.to) }) : ''}
          pending={move.isPending}
          onCancel={() => setAsking(null)}
          onConfirm={(reason) => {
            if (asking) move.mutate({ ...asking, reason }, { onSettled: () => setAsking(null) });
          }}
        />
      </div>
    </TooltipProvider>
  );
}
