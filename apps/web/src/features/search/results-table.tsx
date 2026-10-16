'use client';

import type { BusinessListItem, EnrichmentListingStatus } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Checkbox } from '@bf/ui/components/checkbox';
import { type ColumnDef, DataTable, type RowSelectionState, type VisibilityState } from '@bf/ui/data-table';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  ClockIcon,
  GlobeIcon,
  LoaderCircleIcon,
  type LucideIcon,
  MailIcon,
  StarIcon,
} from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { usePrimaryProfile } from '@/features/scoring/api.ts';
import { ScoreBadge } from '@/features/scoring/score-badge.tsx';
import { useCategories } from './hooks.tsx';
import { safeWebUrl } from './safe-url.ts';
import type { STATUSES } from './url-state.ts';

/** The enrichment status column (BF-027): one icon, its meaning in the label. */
const ENRICHMENT_ICONS: Record<EnrichmentListingStatus, { icon: LucideIcon; className: string }> = {
  none: { icon: CircleDashedIcon, className: 'text-muted-foreground' },
  queued: { icon: ClockIcon, className: 'text-muted-foreground' },
  running: { icon: LoaderCircleIcon, className: 'text-lagoon motion-safe:animate-spin' },
  done: { icon: CircleCheckIcon, className: 'text-kelp' },
  partial: { icon: CircleAlertIcon, className: 'text-amber-600' },
  failed: { icon: CircleXIcon, className: 'text-destructive' },
};

export interface ResultsTableProps {
  readonly items: readonly BusinessListItem[];
  readonly selection: RowSelectionState;
  readonly onSelectionChange: (selection: RowSelectionState) => void;
  readonly onEndReached: () => void;
  readonly onOpen: (item: BusinessListItem) => void;
  readonly activeId: string | null;
  readonly highlightedId: string | null;
  readonly onHover: (id: string | null) => void;
  readonly footer: React.ReactNode;
  readonly empty: React.ReactNode;
}

/** The results as a dense, virtualised table (BF-023): what a sales partner scans row by row. */
export function ResultsTable(props: ResultsTableProps) {
  const t = useTranslations('search.table');
  const status = useTranslations('search.status');
  const via = useTranslations('search.addedVia');
  const enrichment = useTranslations('enrichment.listing');
  const format = useFormatter();
  const { labels } = useCategories();
  const primary = usePrimaryProfile();
  const [visibility, setVisibility] = React.useState<VisibilityState>({ lastActivity: false });

  const columns = React.useMemo<ColumnDef<BusinessListItem, unknown>[]>(
    () => [
      {
        id: 'select',
        header: ({ table }) => (
          <Checkbox
            aria-label={t('selectAll')}
            checked={
              table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? 'indeterminate' : false
            }
            onCheckedChange={(checked) => table.toggleAllRowsSelected(checked === true)}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label={t('select', { name: row.original.displayName })}
            checked={row.getIsSelected()}
            onClick={(event) => event.stopPropagation()}
            onCheckedChange={(checked) => row.toggleSelected(checked === true)}
          />
        ),
        enableSorting: false,
      },
      {
        id: 'name',
        header: t('name'),
        cell: ({ row }) => (
          <div className="min-w-48">
            <span className="font-medium">{row.original.displayName}</span>
          </div>
        ),
      },
      {
        id: 'category',
        header: t('category'),
        cell: ({ row }) =>
          row.original.primaryCategoryId ? (labels.get(row.original.primaryCategoryId)?.label ?? '') : '',
      },
      { id: 'locality', header: t('locality'), cell: ({ row }) => row.original.locality ?? '' },
      {
        id: 'website',
        header: t('website'),
        cell: ({ row }) =>
          safeWebUrl(row.original.websiteUrl) ? (
            <a
              href={safeWebUrl(row.original.websiteUrl) as string}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${t('openWebsite')}: ${row.original.displayName}`}
              className="inline-flex text-lagoon hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              <GlobeIcon aria-hidden className="size-4" />
            </a>
          ) : (
            <span className="text-xs text-reef">{t('noWebsite')}</span>
          ),
      },
      {
        id: 'rating',
        header: t('rating'),
        cell: ({ row }) =>
          row.original.ratingAvg === null ? (
            ''
          ) : (
            <span className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
              <StarIcon aria-hidden className="size-3.5 fill-buoy text-buoy" />
              {format.number(row.original.ratingAvg, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
              <span className="text-xs text-muted-foreground">
                {t('reviews', { count: row.original.ratingCount ?? 0 })}
              </span>
            </span>
          ),
      },
      {
        id: 'email',
        header: t('email'),
        cell: ({ row }) =>
          row.original.hasEmail ? (
            <MailIcon aria-label={t('hasEmail')} className="size-4 text-kelp" />
          ) : (
            <span className="sr-only">{t('noEmail')}</span>
          ),
      },
      {
        id: 'enrichment',
        header: t('enrichment'),
        cell: ({ row }) => {
          const { status: state, finishedAt } = row.original.enrichment;
          const { icon: Icon, className } = ENRICHMENT_ICONS[state];
          const label = enrichment(state);
          const when = finishedAt ? ` · ${format.relativeTime(new Date(finishedAt))}` : '';
          return (
            <span title={`${label}${when}`}>
              <Icon role="img" aria-label={`${label}${when}`} className={`size-4 ${className}`} />
            </span>
          );
        },
      },
      {
        id: 'phone',
        header: t('phone'),
        cell: ({ row }) => (
          <span className="whitespace-nowrap tabular-nums">{row.original.primaryPhone ?? ''}</span>
        ),
      },
      {
        id: 'status',
        header: t('status'),
        cell: ({ row }) => (
          <Badge variant="secondary">
            {status(row.original.pipelineStatus as (typeof STATUSES)[number])}
          </Badge>
        ),
      },
      {
        id: 'score',
        header: t('score'),
        cell: ({ row }) => (
          <ScoreBadge score={row.original.score} tier={row.original.tier} offer={primary?.offer} />
        ),
      },
      {
        id: 'lastActivity',
        header: t('lastActivity'),
        cell: ({ row }) =>
          row.original.lastActivityAt ? format.relativeTime(new Date(row.original.lastActivityAt)) : '',
      },
      { id: 'addedVia', header: t('addedVia'), cell: ({ row }) => via(row.original.addedVia) },
    ],
    [t, status, via, enrichment, format, labels, primary?.offer],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DataTable
        columns={columns}
        data={props.items}
        getRowId={(row) => row.id}
        caption={t('caption')}
        empty={props.empty}
        manualSorting
        columnVisibility={visibility}
        onColumnVisibilityChange={setVisibility}
        rowSelection={props.selection}
        onRowSelectionChange={(updater) =>
          props.onSelectionChange(typeof updater === 'function' ? updater(props.selection) : updater)
        }
        virtualizeAbove={0}
        onEndReached={props.onEndReached}
        onRowClick={props.onOpen}
        onRowHover={(row) => props.onHover(row?.id ?? null)}
        highlightedRowId={props.highlightedId}
        activeRowId={props.activeId}
        className="max-h-none min-h-0 flex-1"
      />
      {props.items.length > 0 ? (
        <div className="px-3 py-2 text-center text-xs text-muted-foreground" aria-live="polite">
          {props.footer}
        </div>
      ) : null}
    </div>
  );
}
