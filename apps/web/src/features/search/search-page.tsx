'use client';

import type { AreaCandidate, BusinessListItem } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@bf/ui/components/sheet';
import { Skeleton } from '@bf/ui/components/skeleton';
import { GlobeIcon, PhoneIcon, RadarIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { useRegisterCommands } from '@/lib/commands.tsx';
import { isTypingTarget } from '@/lib/keyboard.ts';
import { BulkBar } from './bulk-actions/bar.tsx';
import { DiscoveryPanel } from './discovery-panel.tsx';
import { Facets } from './facets.tsx';
import { SearchStateProvider, useFacets, useListing, useListingQuery, useSearchState } from './hooks.tsx';
import { IntentChips } from './intent-chips.tsx';
import { PromptBar } from './prompt-bar.tsx';
import { ResultsTable } from './results-table.tsx';
import { safeWebUrl } from './safe-url.ts';
import { SaveSearchDialog, SearchToolbar } from './toolbar.tsx';
import { FILTER_KEYS } from './url-state.ts';

// The map (MapLibre, ~250 kB) loads only when someone opens it.
const ResultsMap = dynamic(() => import('./results-map.tsx').then((m) => m.ResultsMap), {
  ssr: false,
  loading: () => <Skeleton className="h-full min-h-96 w-full" />,
});

/** `/search` (BF-023): prompt → editable chips → table or map, facets, bulk actions, discovery. */
export function SearchPage() {
  return (
    <SearchStateProvider>
      <SearchScreen />
    </SearchStateProvider>
  );
}

function SearchScreen() {
  const t = useTranslations('search');
  const errorLabels = useErrorLabels();
  const router = useRouter();
  const [state, setState] = useSearchState();
  const query = useListingQuery();
  const listing = useListing(query);
  const facets = useFacets(query);
  const promptRef = React.useRef<HTMLTextAreaElement>(null);
  const [candidates, setCandidates] = React.useState<readonly AreaCandidate[]>([]);
  const [selection, setSelection] = React.useState<Record<string, boolean>>({});
  const [active, setActive] = React.useState<string | null>(null);
  const [hovered, setHovered] = React.useState<string | null>(null);
  const [opened, setOpened] = React.useState<BusinessListItem | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [discovering, setDiscovering] = React.useState(false);

  const items = React.useMemo(() => listing.data?.pages.flatMap((p) => p.items) ?? [], [listing.data]);
  // A selection belongs to the results it was made in: a new query starts a new one (never act on hidden rows).
  const queryKey = JSON.stringify(query);
  React.useEffect(() => {
    setSelection({});
    setActive(null);
  }, [queryKey]);
  const selectedIds = Object.keys(selection).filter((id) => selection[id]);
  const loadMore = () => {
    if (listing.hasNextPage && !listing.isFetchingNextPage) void listing.fetchNextPage();
  };

  useRegisterCommands([
    {
      id: 'search.new',
      label: t('commands.new'),
      group: t('commands.group'),
      run: () => {
        void setState(Object.fromEntries([...FILTER_KEYS, 'prompt', 'sort', 'run'].map((k) => [k, null])));
        promptRef.current?.focus();
      },
    },
    {
      id: 'search.discover',
      label: t('commands.discover'),
      group: t('commands.group'),
      run: () => setDiscovering(true),
    },
    {
      id: 'search.saved',
      label: t('commands.saved'),
      group: t('commands.group'),
      run: () => router.push('/search/saved'),
    },
    {
      id: 'search.lists',
      label: t('commands.lists'),
      group: t('commands.group'),
      run: () => router.push('/lists'),
    },
  ]);

  // Keyboard: / prompt · j/k move · x select · Enter open · m map · s save.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) || document.querySelector('[role="dialog"]')) return;
      // Enter and x belong to the focused control (a chip, a checkbox, a button) when there is one.
      const onControl =
        event.target instanceof Element &&
        event.target !== document.body &&
        event.target.closest(
          'button, a[href], input, select, [role="checkbox"], [role="option"], [role="menuitem"]',
        ) !== null;
      if ((event.key === 'Enter' || event.key === 'x') && onControl) return;
      const index = active ? items.findIndex((i) => i.id === active) : -1;
      const move = (to: number) => {
        const next = items[Math.max(0, Math.min(items.length - 1, to))];
        if (next) setActive(next.id);
        if (to >= items.length - 5) loadMore();
      };
      switch (event.key) {
        case '/':
          event.preventDefault();
          promptRef.current?.focus();
          break;
        case 'j':
          move(index + 1);
          break;
        case 'k':
          move(index - 1);
          break;
        case 'x':
          if (active) setSelection((s) => ({ ...s, [active]: !s[active] }));
          break;
        case 'Enter': {
          const item = items[index];
          if (item) setOpened(item);
          break;
        }
        case 'm':
          void setState({ view: state.view === 'map' ? 'table' : 'map' });
          break;
        case 's':
          event.preventDefault();
          setSaving(true);
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const hasFilters = FILTER_KEYS.some((key) => state[key] !== null);
  const empty = hasFilters ? (
    <EmptyState
      title={t('empty.noResultsTitle')}
      description={t('empty.noResultsBody')}
      action={
        <div className="flex gap-2">
          <Button type="button" onClick={() => setDiscovering(true)}>
            <RadarIcon aria-hidden />
            {t('empty.discover')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void setState(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])))}
          >
            {t('empty.clear')}
          </Button>
        </div>
      }
    />
  ) : (
    <EmptyState title={t('empty.noPromptTitle')} description={t('empty.noPromptBody')} />
  );

  return (
    <div className="flex h-[calc(100dvh-7rem)] min-h-[32rem] flex-col gap-3">
      <h1 className="sr-only">{t('title')}</h1>
      <PromptBar
        inputRef={promptRef}
        onParsed={(parsed) =>
          setCandidates(
            parsed
              ? [
                  ...(parsed.response.resolvedArea ? [parsed.response.resolvedArea] : []),
                  ...parsed.response.alternatives,
                ]
              : [],
          )
        }
      />
      <IntentChips candidates={candidates} />
      <SearchToolbar
        count={items.length}
        more={listing.hasNextPage}
        onSave={() => setSaving(true)}
        onDiscover={() => setDiscovering(true)}
      />
      <BulkBar selection={{ ids: selectedIds, query }} onClear={() => setSelection({})} />
      <div className="flex min-h-0 flex-1 gap-4">
        <aside className="hidden w-60 shrink-0 overflow-y-auto pr-1 lg:block">
          <Facets facets={facets.data} loading={facets.isLoading} />
        </aside>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-busy={listing.isFetching}>
          {listing.isError ? (
            <ErrorState
              problem={toProblemLike(listing.error, t('error'))}
              labels={errorLabels}
              onRetry={() => void listing.refetch()}
            />
          ) : listing.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 10 }, (_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : state.view === 'map' ? (
            <ResultsMap
              items={items}
              highlightedId={hovered ?? active}
              onHover={setHovered}
              onOpen={setOpened}
            />
          ) : (
            <ResultsTable
              items={items}
              selection={selection}
              onSelectionChange={setSelection}
              onEndReached={loadMore}
              onOpen={setOpened}
              activeId={active}
              highlightedId={hovered}
              onHover={setHovered}
              empty={empty}
              footer={
                listing.isFetchingNextPage
                  ? t('table.loadingMore')
                  : listing.hasNextPage
                    ? null
                    : t('table.end')
              }
            />
          )}
        </section>
      </div>
      <Sheet open={opened !== null} onOpenChange={(open) => (open ? undefined : setOpened(null))}>
        <SheetContent>
          {opened ? (
            <>
              <SheetHeader>
                <SheetTitle>{opened.displayName}</SheetTitle>
                <SheetDescription>
                  {[opened.locality, opened.countryCode].filter(Boolean).join(', ')}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-3 px-4 text-sm">
                {safeWebUrl(opened.websiteUrl) ? (
                  <a
                    className="flex items-center gap-2 text-lagoon hover:underline"
                    href={safeWebUrl(opened.websiteUrl) as string}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <GlobeIcon aria-hidden className="size-4" />
                    {opened.websiteUrl}
                  </a>
                ) : null}
                {opened.primaryPhone ? (
                  <a className="flex items-center gap-2 hover:underline" href={`tel:${opened.primaryPhone}`}>
                    <PhoneIcon aria-hidden className="size-4" />
                    {opened.primaryPhone}
                  </a>
                ) : null}
                <p className="text-muted-foreground">{t('table.detailSoon')}</p>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
      <SaveSearchDialog open={saving} onOpenChange={setSaving} />
      <DiscoveryPanel open={discovering} onOpenChange={setDiscovering} />
    </div>
  );
}
