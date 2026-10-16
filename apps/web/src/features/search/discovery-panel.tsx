'use client';

import type {
  DiscoveryProviderList,
  DiscoveryRun,
  DiscoveryRunEstimate,
  ProviderId,
  RunCounts,
} from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Progress } from '@bf/ui/components/progress';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@bf/ui/components/sheet';
import { Switch } from '@bf/ui/components/switch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { useRealtimeEvent } from '@/lib/realtime/provider.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useSearchState } from './hooks.tsx';

const RUN_PROGRESSED = 'discovery.run.progressed';
const RUN_FINISHED = 'discovery.run.completed';
const TERMINAL = new Set(['completed', 'partially_completed', 'failed', 'cancelled']);

// The run started from this tab, whose end is announced with a toast (once). Session storage, not component
// state: the URL update that follows the start can remount the search screen.
const STARTED_KEY = 'bf:discovery:started';
const markStarted = (runId: string) => {
  try {
    sessionStorage.setItem(STARTED_KEY, runId);
  } catch {
    // Storage blocked: no completion toast, the panel still shows the result.
  }
};
const takeStarted = (runId: string): boolean => {
  try {
    if (sessionStorage.getItem(STARTED_KEY) !== runId) return false;
    sessionStorage.removeItem(STARTED_KEY);
    return true;
  } catch {
    return false;
  }
};

interface RunProgress {
  readonly status: DiscoveryRun['status'];
  readonly counts: RunCounts;
  readonly costUsd: number;
  readonly budgetUsd: number;
}

/**
 * Discovery from the search (BF-023): providers, cost estimate, budget, start; then live progress (realtime) and
 * cancel. New businesses stream into the table, which follows the run (`run` in the URL).
 */
export function DiscoveryPanel({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('search.discovery');
  const format = useFormatter();
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  const [state, setState] = useSearchState();
  const [chosen, setChosen] = React.useState<ProviderId[] | null>(null);
  const [budget, setBudget] = React.useState('');
  const [autoEnrich, setAutoEnrich] = React.useState(false);

  const providers = useQuery({
    queryKey: queryKeys.discovery.providers(),
    queryFn: async () => (await apiClient().GET('/v1/discovery/providers')).data as DiscoveryProviderList,
    enabled: open,
  });
  const ready = (providers.data?.items ?? []).filter((p) => p.status === 'ready');
  const selected = chosen ?? ready.map((p) => p.id);
  const run = useQuery({
    queryKey: queryKeys.discovery.run(state.run ?? ''),
    queryFn: async () =>
      (await apiClient().GET('/v1/discovery-runs/{id}', { params: { path: { id: state.run as string } } }))
        .data as DiscoveryRun,
    enabled: state.run !== null,
    // Realtime keeps it current; polling covers a missed event (reconnects, a run that ends within a second).
    refetchInterval: (query) => (query.state.data && !TERMINAL.has(query.state.data.status) ? 2_000 : false),
  });
  const live: RunProgress | null = run.data ?? null;

  const area = state.area
    ? { areaId: state.area }
    : state.near
      ? (() => {
          const [lat, lng] = state.near.split(',').map(Number);
          return {
            geometry: {
              type: 'Circle' as const,
              center: { lat: lat ?? 0, lng: lng ?? 0 },
              radiusM: (state.radiusKm ?? 5) * 1000,
            },
          };
        })()
      : null;
  const categories = state.category ?? [];
  const keywords = [...(state.keyword ?? []), ...(state.q ? [state.q] : [])].join(' ').trim();
  const request =
    area && (categories.length > 0 || keywords)
      ? {
          intent: {
            categoryIds: categories,
            ...(keywords ? { keywords: keywords.slice(0, 200) } : {}),
            languageCode: locale === 'fr' ? 'fr' : 'en',
          },
          area,
          providers: selected,
          ...(budget ? { budgetUsd: Number(budget) } : {}),
          options: { autoEnrich, maxResults: 2_000, tileStrategy: 'auto' as const },
        }
      : null;

  const estimate = useMutation({
    mutationFn: async () =>
      (await apiClient().POST('/v1/discovery-runs/estimate', { body: request as never }))
        .data as DiscoveryRunEstimate,
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });
  const start = useMutation({
    mutationFn: async () =>
      (
        await apiClient().POST('/v1/discovery-runs', {
          body: request as never,
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        })
      ).data as DiscoveryRun,
    onSuccess: async (created) => {
      markStarted(created.id);
      client.setQueryData(queryKeys.discovery.run(created.id), created);
      await setState({ run: created.id });
    },
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });
  const cancel = useMutation({
    mutationFn: async () =>
      apiClient().POST('/v1/discovery-runs/{id}/cancel', { params: { path: { id: state.run as string } } }),
    onSuccess: async () => (await getToast()).message(t('cancelled')),
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });

  const onProgress = (event: { entityId: string; payload: unknown }) => {
    if (event.entityId !== state.run) return;
    client.setQueryData(queryKeys.discovery.run(event.entityId), (old: DiscoveryRun | undefined) =>
      old ? { ...old, ...(event.payload as RunProgress) } : old,
    );
    // New businesses arrive in the listing as the run ingests them.
    void client.invalidateQueries({ queryKey: queryKeys.search.all });
  };
  useRealtimeEvent(RUN_PROGRESSED, onProgress);
  useRealtimeEvent(RUN_FINISHED, onProgress);

  const status = live?.status;
  const runId = run.data?.id ?? null;
  const created = live?.counts.created ?? 0;
  React.useEffect(() => {
    if (!runId || !status || !TERMINAL.has(status) || !takeStarted(runId)) return;
    void client.invalidateQueries({ queryKey: queryKeys.search.all });
    void getToast().then((toast) => {
      if (status === 'failed') toast.error(t('failed'));
      else toast.success(t('completed', { count: created }));
    });
  }, [status, runId, client, t, created]);

  const usd = (value: number) =>
    value === 0 ? t('free') : format.number(value, { style: 'currency', currency: 'USD' });
  const running = live !== null && !TERMINAL.has(live.status);
  const e = estimate.data;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t('title')}</SheetTitle>
          <SheetDescription>{t('description')}</SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-6">
          {live && state.run ? (
            <section
              aria-live="polite"
              className="space-y-2 rounded-lg border border-lagoon/40 bg-lagoon-wash p-3"
            >
              <p className="font-medium">{running ? t('running') : t(`statuses.${live.status}`)}</p>
              <Progress
                value={
                  live.counts.tasksTotal > 0 ? (100 * live.counts.tasksDone) / live.counts.tasksTotal : 0
                }
                aria-label={t('progress', { done: live.counts.tasksDone, total: live.counts.tasksTotal })}
              />
              <p className="text-sm">
                {t('progress', { done: live.counts.tasksDone, total: live.counts.tasksTotal })}
              </p>
              <ul className="flex flex-wrap gap-x-4 text-sm">
                <li>{t('created', { count: live.counts.created })}</li>
                <li>{t('merged', { count: live.counts.merged })}</li>
                <li>{t('duplicates', { count: live.counts.unchanged })}</li>
              </ul>
              <p className="text-sm">{t('cost', { cost: usd(live.costUsd) })}</p>
              <div className="flex gap-2">
                {running ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={cancel.isPending}
                    onClick={() => cancel.mutate()}
                  >
                    {t('cancel')}
                  </Button>
                ) : null}
                <Button type="button" size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                  {t('close')}
                </Button>
              </div>
            </section>
          ) : null}
          {!area ? <p className="text-sm text-reef">{t('needsPlace')}</p> : null}
          {area && !request ? <p className="text-sm text-reef">{t('needsCategory')}</p> : null}
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">{t('providers')}</legend>
            {ready.map((provider) => (
              <div key={provider.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={`provider-${provider.id}`}
                  checked={selected.includes(provider.id)}
                  onCheckedChange={(checked) =>
                    setChosen(
                      checked ? [...selected, provider.id] : selected.filter((id) => id !== provider.id),
                    )
                  }
                />
                <Label htmlFor={`provider-${provider.id}`} className="font-normal">
                  {provider.label}
                </Label>
              </div>
            ))}
          </fieldset>
          <div className="space-y-1">
            <Label htmlFor="discovery-budget">{t('budget')}</Label>
            <Input
              id="discovery-budget"
              type="number"
              min={0}
              max={10_000}
              step={1}
              inputMode="decimal"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              className="w-32"
            />
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Switch id="discovery-enrich" checked={autoEnrich} onCheckedChange={setAutoEnrich} />
            <Label htmlFor="discovery-enrich" className="font-normal">
              {t('autoEnrich')}
            </Label>
          </div>
          {e ? (
            <p className="text-sm" aria-live="polite">
              {t('estimateResult', {
                tiles: e.totals.tasks,
                calls: format.number(e.totals.calls.expected),
                low: usd(e.totals.costUsd.min),
                high: usd(e.totals.costUsd.max),
                results: format.number(e.providers.reduce((sum, p) => sum + p.results.max, 0)),
              })}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!request || selected.length === 0 || estimate.isPending}
              onClick={() => estimate.mutate()}
            >
              {estimate.isPending ? t('estimating') : t('estimate')}
            </Button>
            <Button
              type="button"
              disabled={!request || selected.length === 0 || !e || start.isPending || running}
              onClick={() => start.mutate()}
            >
              {start.isPending ? t('starting') : t('start')}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
