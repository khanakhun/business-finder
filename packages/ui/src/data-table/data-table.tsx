'use client';

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type OnChangeFn,
  type RowSelectionState,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from '@tanstack/react-table';
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import * as React from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/table.tsx';
import { cn } from '../lib/utils.ts';
import { useVirtualRows } from './use-virtual-rows.ts';

export type { ColumnDef, RowSelectionState, SortingState, VisibilityState } from '@tanstack/react-table';

export interface DataTableProps<TRow> {
  readonly columns: ColumnDef<TRow, unknown>[];
  readonly data: readonly TRow[];
  /** Stable row id (used for selection across pages and re-sorts). */
  readonly getRowId: (row: TRow) => string;
  /** Shown when `data` is empty (pass an EmptyState). */
  readonly empty: React.ReactNode;
  readonly sorting?: SortingState;
  readonly onSortingChange?: OnChangeFn<SortingState>;
  /** Server-side sorting (URL state) — the table only reports changes. */
  readonly manualSorting?: boolean;
  readonly columnVisibility?: VisibilityState;
  readonly onColumnVisibilityChange?: OnChangeFn<VisibilityState>;
  readonly rowSelection?: RowSelectionState;
  readonly onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  /** Virtualise rows above this count (long result lists). */
  readonly virtualizeAbove?: number;
  readonly onRowClick?: (row: TRow) => void;
  /** Called when the scroll nears the end (load the next page). */
  readonly onEndReached?: () => void;
  /** Pointer enters/leaves a row (e.g. to highlight it on a map). */
  readonly onRowHover?: (row: TRow | null) => void;
  /** Row shown as highlighted (hovered elsewhere, e.g. its map marker). */
  readonly highlightedRowId?: string | null;
  /** Keyboard cursor (j/k): marked and kept in view. */
  readonly activeRowId?: string | null;
  readonly caption?: string;
  readonly className?: string;
}

/** TanStack Table v8 foundation: sorting, column visibility, row selection, optional row virtualisation. */
export function DataTable<TRow>(props: DataTableProps<TRow>) {
  const {
    columns,
    data,
    getRowId,
    empty,
    sorting,
    onSortingChange,
    manualSorting = false,
    columnVisibility,
    onColumnVisibilityChange,
    rowSelection,
    onRowSelectionChange,
    virtualizeAbove = 200,
    onRowClick,
    onEndReached,
    onRowHover,
    highlightedRowId,
    activeRowId,
    caption,
    className,
  } = props;

  const table = useReactTable({
    data: data as TRow[],
    columns,
    getRowId,
    state: {
      ...(sorting ? { sorting } : {}),
      ...(columnVisibility ? { columnVisibility } : {}),
      ...(rowSelection ? { rowSelection } : {}),
    },
    ...(onSortingChange ? { onSortingChange } : {}),
    ...(onColumnVisibilityChange ? { onColumnVisibilityChange } : {}),
    ...(onRowSelectionChange ? { onRowSelectionChange, enableRowSelection: true } : {}),
    manualSorting,
    getCoreRowModel: getCoreRowModel(),
    ...(manualSorting ? {} : { getSortedRowModel: getSortedRowModel() }),
  });

  const rows = table.getRowModel().rows;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtual = useVirtualRows({ count: rows.length, scrollRef, enabled: rows.length > virtualizeAbove });
  const activeIndex = activeRowId ? rows.findIndex((row) => row.id === activeRowId) : -1;
  React.useEffect(() => {
    if (activeIndex < 0) return;
    virtual.scrollToIndex(activeIndex);
  }, [activeIndex, virtual.scrollToIndex]);
  const onScroll = onEndReached
    ? (event: React.UIEvent<HTMLDivElement>) => {
        const el = event.currentTarget;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) onEndReached();
      }
    : undefined;

  if (data.length === 0) return <>{empty}</>;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={cn(
        'overflow-auto rounded-lg border bg-surface',
        virtual.enabled && 'max-h-[70vh]',
        className,
      )}
    >
      <Table>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <TableHeader className="sticky top-0 z-10 bg-surface">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                const canSort = header.column.getCanSort();
                return (
                  <TableHead
                    key={header.id}
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                  >
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 font-medium hover:text-foreground"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted === 'asc' ? <ArrowUpIcon aria-hidden className="size-3.5" /> : null}
                        {sorted === 'desc' ? <ArrowDownIcon aria-hidden className="size-3.5" /> : null}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {virtual.paddingTop > 0 ? <tr aria-hidden style={{ height: virtual.paddingTop }} /> : null}
          {virtual.indexes(rows.length).map((index) => {
            const row = rows[index];
            if (!row) return null;
            return (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() ? 'selected' : undefined}
                data-active={row.id === activeRowId ? 'true' : undefined}
                data-highlighted={row.id === highlightedRowId ? 'true' : undefined}
                aria-current={row.id === activeRowId ? 'true' : undefined}
                className={cn(
                  // The waterline marks the selected row, as it marks the active nav item.
                  'data-[state=selected]:bg-lagoon-wash data-[state=selected]:shadow-[inset_2px_0_0_var(--lagoon)]',
                  'data-[highlighted=true]:bg-buoy-wash data-[active=true]:outline-2 data-[active=true]:-outline-offset-2 data-[active=true]:outline-lagoon',
                  onRowClick && 'cursor-pointer',
                )}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                onPointerEnter={onRowHover ? () => onRowHover(row.original) : undefined}
                onPointerLeave={onRowHover ? () => onRowHover(null) : undefined}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
          {virtual.paddingBottom > 0 ? <tr aria-hidden style={{ height: virtual.paddingBottom }} /> : null}
        </TableBody>
      </Table>
    </div>
  );
}
