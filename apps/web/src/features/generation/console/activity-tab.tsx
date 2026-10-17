'use client';

import { Button } from '@bf/ui/components/button';
import { Input } from '@bf/ui/components/input';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownIcon, SearchIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { FILTERS, type Filter, type LoggedEvent, rowsOf, usageOf } from './event-log.ts';
import { EventRow } from './event-renderers.tsx';
import type { StreamState } from './use-job-events.ts';

// The Activity tab (BF-046): the job's events grouped by attempt, filtered and searched, in a virtualized list
// (10 000 events stay smooth). New events keep the view at the bottom unless the reader scrolled up; then "Jump to
// latest" brings them back.

/** Within this many pixels of the end, the reader is "at the bottom" and follows new events. */
const STICKY_PX = 48;

export function ActivityTab({
  events,
  state,
  budgetUsd,
}: {
  readonly events: readonly LoggedEvent[];
  readonly state: StreamState;
  readonly budgetUsd: number;
}) {
  const t = useTranslations('generation.console');
  const format = useFormatter();
  const [filter, setFilter] = React.useState<Filter>('all');
  const [search, setSearch] = React.useState('');
  const rows = React.useMemo(() => rowsOf(events, filter, search), [events, filter, search]);
  const usage = React.useMemo(() => usageOf(events), [events]);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [following, setFollowing] = React.useState(true);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'attempt' ? 36 : 28),
    overscan: 20,
    getItemKey: (index) => rows[index]?.key ?? index,
  });
  React.useEffect(() => {
    if (following && rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [following, rows.length, virtualizer]);
  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < STICKY_PX);
  };
  const money = (value: number) =>
    format.number(value, { style: 'currency', currency: 'USD', maximumFractionDigits: 3 });
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <fieldset className="flex gap-1">
          <legend className="sr-only">{t('filter')}</legend>
          {FILTERS.map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={filter === value ? 'secondary' : 'ghost'}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {t(`filters.${value}`)}
            </Button>
          ))}
        </fieldset>
        <div className="relative">
          <SearchIcon aria-hidden className="absolute top-2 left-2 size-4 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('search')}
            aria-label={t('search')}
            className="h-8 w-48 pl-8"
          />
        </div>
        <p className="ml-auto text-xs text-muted-foreground tabular-nums" data-testid="console-usage">
          {t('usage', {
            cost: money(usage.costUsd),
            budget: money(budgetUsd),
            tokens: format.number(usage.tokens),
          })}
        </p>
        <p className="text-xs" role="status" data-testid="stream-state">
          {t(`stream.${state}`)}
        </p>
      </div>
      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-[60vh] overflow-auto rounded-lg border bg-card text-sm"
          role="log"
          data-event-count={events.filter((event) => event.type !== 'heartbeat').length}
          aria-label={t('activity')}
          aria-live="off"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1).
          tabIndex={0}
        >
          {rows.length === 0 ? (
            <p className="p-4 text-muted-foreground">{state === 'connecting' ? t('loading') : t('empty')}</p>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                if (!row) return null;
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="absolute inset-x-0 px-3"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {row.kind === 'attempt' ? (
                      <h3 className="mt-2 border-b pb-1 text-xs font-semibold uppercase text-muted-foreground">
                        {row.attempt === null ? t('review') : t('attempt', { attempt: row.attempt })}
                      </h3>
                    ) : (
                      <div className="flex gap-3 py-1" data-event-type={row.event.type}>
                        <time
                          dateTime={row.event.at}
                          className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
                        >
                          {format.dateTime(new Date(row.event.at), { timeStyle: 'medium' })}
                        </time>
                        <EventRow event={row.event} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {!following ? (
          <Button
            type="button"
            size="sm"
            className="absolute right-4 bottom-4 shadow"
            onClick={() => setFollowing(true)}
          >
            <ArrowDownIcon aria-hidden />
            {t('jumpToLatest')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
