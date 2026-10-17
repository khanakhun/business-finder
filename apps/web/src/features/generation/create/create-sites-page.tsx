'use client';

import type { BriefOverrides, BusinessListItem } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { PageHeader } from '@bf/ui/components/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Switch } from '@bf/ui/components/switch';
import { TooltipProvider } from '@bf/ui/components/tooltip';
import { ChevronDownIcon, ChevronRightIcon, LayoutTemplateIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { ScoreBadge } from '@/features/scoring/score-badge.tsx';
import { useCategories } from '@/features/search/hooks.tsx';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useBusinessSite, useCreateBatch, useEngines, useGenerationSettings, useSelection } from '../api.ts';
import { defaultParallel, type PickableEngine, unavailableReason } from '../engines.ts';
import { move } from '../reorder.ts';
import { SortableList } from '../sortable-list.tsx';
import { AssignEngines } from './assign-engines.tsx';
import { BriefPreview } from './brief-preview.tsx';
import { EngineSelect } from './engine-select.tsx';
import { EstimatePanel } from './estimate-panel.tsx';

// "Create sites" (BF-046): the selected businesses in priority order (drag, or move up/down), an engine each, one by
// one or in parallel, the brief of each with overrides, and an estimate. One idempotency key per visit of the page:
// a double click or a retry after a network error returns the same batch.

export const MAX_ITEMS = 50;

interface Item {
  readonly id: string;
  readonly label: string;
  readonly business: BusinessListItem;
  readonly engine: PickableEngine;
  readonly overrides: BriefOverrides;
}

type RunMode = 'sequential' | 'parallel';

export function CreateSitesPage() {
  const t = useTranslations('generation.create');
  const errorLabels = useErrorLabels();
  const router = useRouter();
  const canGenerate = usePermission('sites:generate');
  const [ids] = useQueryState('ids', parseAsArrayOf(parseAsString).withDefault([]));
  const selected = React.useMemo(() => [...new Set(ids)].slice(0, MAX_ITEMS), [ids]);
  const selection = useSelection(selected);
  const engines = useEngines();
  const create = useCreateBatch();
  const settings = useGenerationSettings();
  const [idempotencyKey] = React.useState(() => crypto.randomUUID());
  const [items, setItems] = React.useState<Item[] | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<RunMode | null>(null);
  const [parallel, setParallel] = React.useState<number | null>(null);
  const [autoPublish, setAutoPublish] = React.useState(true);
  const [name, setName] = React.useState('');
  const [budget, setBudget] = React.useState('');

  // The selection arrives once; from then on the page owns the order and the choices.
  // Each item starts on the workspace's default engine (Settings → Generation).
  const defaultEngine = settings.data?.settings.defaultEngine ?? 'auto';
  React.useEffect(() => {
    if (items || !selection.data || settings.isLoading) return;
    setItems(
      selection.data.map((business) => ({
        id: business.id,
        label: business.displayName,
        business,
        engine: defaultEngine,
        overrides: {},
      })),
    );
  }, [items, selection.data, settings.isLoading, defaultEngine]);

  if (!canGenerate) return <EmptyState title={t('forbidden')} />;
  if (selected.length === 0) {
    return (
      <>
        <PageHeader title={t('title')} />
        <EmptyState
          icon={<LayoutTemplateIcon aria-hidden />}
          title={t('empty')}
          description={t('emptyHint')}
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/search">{t('toSearch')}</Link>
            </Button>
          }
        />
      </>
    );
  }
  if (selection.isError) {
    return (
      <ErrorState
        problem={toProblemLike(selection.error, t('loadError'))}
        labels={errorLabels}
        onRetry={() => void selection.refetch()}
      />
    );
  }
  if (!items) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-64" />
        {selected.map((id) => (
          <Skeleton key={id} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  // The workspace's default run mode until the person picks one (Settings → Generation).
  const runMode: RunMode = mode ?? settings.data?.settings.defaultRunMode ?? 'parallel';
  const chosen = items.map((item) => item.engine);
  const slots = defaultParallel(chosen, engines.data);
  const maxParallel = runMode === 'sequential' ? 1 : Math.min(items.length, parallel ?? slots);
  const blocked = items.some((item) => unavailableReason(item.engine, engines.data) !== null);
  const update = (id: string, patch: Partial<Item>) =>
    setItems((current) => current?.map((item) => (item.id === id ? { ...item, ...patch } : item)) ?? null);
  const remove = (id: string) => setItems((current) => current?.filter((item) => item.id !== id) ?? null);
  const budgetUsd = Number(budget);
  const submit = async () => {
    if (items.length === 0 || blocked || create.isPending) return;
    try {
      const batch = await create.mutateAsync({
        idempotencyKey,
        body: {
          ...(name.trim() ? { name: name.trim() } : {}),
          items: items.map((item) => ({
            businessId: item.id,
            engine: item.engine,
            ...(budget && budgetUsd > 0 ? { budgetUsd } : {}),
            ...(Object.keys(item.overrides).length > 0 ? { briefOverrides: item.overrides } : {}),
          })),
          settings: { maxParallel, autoPublishPreview: autoPublish },
        },
      });
      router.push(`/generation/batches/${batch.id}`);
    } catch (error) {
      (await getToast()).error(toProblemLike(error, t('submitError')).title ?? t('submitError'));
    }
  };

  return (
    <TooltipProvider>
      <PageHeader title={t('title')} description={t('description', { count: items.length })} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-labelledby="items-title" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="items-title" className="text-sm font-medium">
              {t('order')}
            </h2>
            <div className="flex flex-wrap gap-2">
              <Select
                onValueChange={(engine) =>
                  setItems(
                    (current) =>
                      current?.map((item) => ({ ...item, engine: engine as PickableEngine })) ?? null,
                  )
                }
              >
                <SelectTrigger size="sm" aria-label={t('applyAll')} className="w-44">
                  <SelectValue placeholder={t('applyAll')} />
                </SelectTrigger>
                <SelectContent>
                  {(['auto', 'blocks', 'claude-agent-sdk', 'claude-code', 'codex'] as const)
                    .filter((engine) => unavailableReason(engine, engines.data) === null)
                    .map((engine) => (
                      <SelectItem key={engine} value={engine}>
                        <EngineName engine={engine} />
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <AssignEngines
                count={items.length}
                presets={settings.data?.settings.presets ?? []}
                onApply={(assigned) =>
                  setItems(
                    (current) =>
                      current?.map((item, index) => ({ ...item, engine: assigned[index] ?? item.engine })) ??
                      null,
                  )
                }
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('orderHint')}</p>
          <SortableList
            items={items}
            label={t('order')}
            onMove={(id, to) =>
              setItems((current) =>
                current
                  ? move(
                      current,
                      current.findIndex((item) => item.id === id),
                      to,
                    )
                  : current,
              )
            }
            renderItem={(item) => (
              <ItemRow
                item={item}
                listing={engines.data}
                expanded={expanded === item.id}
                onToggle={() => setExpanded((open) => (open === item.id ? null : item.id))}
                onChange={(patch) => update(item.id, patch)}
                onRemove={items.length > 1 ? () => remove(item.id) : undefined}
              />
            )}
          />
        </section>
        <div className="space-y-4">
          <fieldset className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{t('runMode')}</legend>
            {(['sequential', 'parallel'] as const).map((value) => (
              <label key={value} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="run-mode"
                  value={value}
                  checked={runMode === value}
                  onChange={() => setMode(value)}
                  className="mt-1"
                />
                <span>
                  {t(`mode.${value}`)}
                  {value === 'parallel' && runMode === 'parallel' ? (
                    <span className="mt-1 flex items-center gap-2">
                      <Label htmlFor="max-parallel" className="text-xs font-normal">
                        {t('upTo')}
                      </Label>
                      <Input
                        id="max-parallel"
                        type="number"
                        min={1}
                        max={Math.min(20, items.length)}
                        value={maxParallel}
                        onChange={(event) =>
                          setParallel(Math.max(1, Math.min(20, Number(event.target.value) || 1)))
                        }
                        className="h-8 w-16"
                      />
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
            <p className="text-xs text-muted-foreground">{t('limitsHint')}</p>
          </fieldset>
          <fieldset className="space-y-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{t('settings')}</legend>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="auto-publish" className="font-normal">
                {t('autoPublish')}
              </Label>
              <Switch id="auto-publish" checked={autoPublish} onCheckedChange={setAutoPublish} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="batch-name">{t('name')}</Label>
              <Input
                id="batch-name"
                value={name}
                maxLength={120}
                placeholder={t('namePlaceholder')}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="item-budget">{t('budget')}</Label>
              <Input
                id="item-budget"
                type="number"
                inputMode="decimal"
                min={0.01}
                max={100}
                step={0.01}
                value={budget}
                placeholder={t('budgetPlaceholder')}
                onChange={(event) => setBudget(event.target.value)}
              />
            </div>
          </fieldset>
          <EstimatePanel engines={chosen} listing={engines.data} maxParallel={maxParallel} />
          {blocked ? <p className="text-sm text-destructive">{t('blocked')}</p> : null}
          <Button
            type="button"
            className="w-full"
            disabled={items.length === 0 || blocked || create.isPending}
            onClick={() => void submit()}
          >
            {t('submit', { count: items.length })}
          </Button>
        </div>
      </div>
    </TooltipProvider>
  );
}

function EngineName({ engine }: { readonly engine: PickableEngine }) {
  const t = useTranslations('generation.engines.name');
  return <>{t(engine)}</>;
}

function ItemRow({
  item,
  listing,
  expanded,
  onToggle,
  onChange,
  onRemove,
}: {
  readonly item: Item;
  readonly listing: Parameters<typeof EngineSelect>[0]['listing'];
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onChange: (patch: Partial<Item>) => void;
  readonly onRemove: (() => void) | undefined;
}) {
  const t = useTranslations('generation.create');
  const { labels } = useCategories();
  const site = useBusinessSite(item.id);
  const { business } = item;
  const category = business.primaryCategoryId ? labels.get(business.primaryCategoryId)?.label : null;
  const overridden = Object.keys(item.overrides).length > 0;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{business.displayName}</span>
            <ScoreBadge score={business.score} tier={business.tier} />
            {site.data ? (
              <Badge variant="outline">
                {t('regenerate', { version: site.data.currentVersion?.versionNumber ?? 0 })}
              </Badge>
            ) : site.isSuccess ? (
              <Badge variant="secondary">{t('newSite')}</Badge>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {[category, business.locality].filter(Boolean).join(' · ')}
          </p>
        </div>
        <EngineSelect
          value={item.engine}
          onChange={(engine) => onChange({ engine })}
          listing={listing}
          label={t('engineFor', { name: business.displayName })}
        />
        {onRemove ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={t('remove', { name: business.displayName })}
            onClick={onRemove}
          >
            <XIcon aria-hidden />
          </Button>
        ) : null}
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="-ml-2 h-7"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {expanded ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
        {t('brief')}
        {overridden ? <Badge variant="secondary">{t('overridden')}</Badge> : null}
      </Button>
      {expanded ? (
        <BriefPreview
          businessId={item.id}
          overrides={item.overrides}
          onChange={(overrides) => onChange({ overrides })}
        />
      ) : null}
    </div>
  );
}
