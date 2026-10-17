'use client';

import { type MlModel, OFFERS, type Offer } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { Label } from '@bf/ui/components/label';
import { Progress } from '@bf/ui/components/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Textarea } from '@bf/ui/components/textarea';
import { CheckIcon, XIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useScoringProfiles } from '../api.ts';
import {
  useComparison,
  useMlActions,
  useMlDatasets,
  useMlModels,
  useMlReadiness,
  useMlRuns,
  usePromotions,
  useShadowAssignments,
} from './api.ts';
import { ModelCard } from './model-card.tsx';

// Settings → Scoring → Models (BF-059): whether the workspace has enough outcomes, datasets and training runs, the
// trained models (cards), shadow mode beside a profile, the prospective comparison with the promotion criteria,
// promotion (or an explicit override with a reason) and rollback. Owners and admins (`scoring:manage`).

const NONE = 'none';

async function run(action: () => Promise<unknown>, done: string, failed: string) {
  const toast = await getToast();
  try {
    await action();
    toast.success(done);
  } catch (error) {
    const problem = toProblemLike(error, failed);
    toast.error(problem.detail ?? problem.title);
  }
}

/** Shown to owners and admins only. */
export function ModelsSection() {
  const canManage = usePermission('scoring:manage');
  return canManage ? <Models /> : null;
}

function Models() {
  const t = useTranslations('scoringModels');
  const offers = useTranslations('scoring.offers');
  const format = useFormatter();
  const [offer, setOffer] = React.useState<Offer>('website_redesign');
  const readiness = useMlReadiness(offer);
  const datasets = useMlDatasets();
  const runs = useMlRuns();
  const models = useMlModels();
  const actions = useMlActions();
  const ready = readiness.data;
  return (
    <section className="space-y-6" aria-labelledby="scoring-models">
      <header className="space-y-1">
        <h2 id="scoring-models" className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </header>

      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="ml-offer">{t('offer')}</Label>
            <Select value={offer} onValueChange={(value) => setOffer(value as Offer)}>
              <SelectTrigger id="ml-offer" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OFFERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {offers(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            className="ml-auto"
            disabled={!ready?.ready || actions.build.isPending}
            onClick={() =>
              void run(() => actions.build.mutateAsync({ offer }), t('datasetBuilt'), t('failed'))
            }
          >
            {t('buildDataset')}
          </Button>
        </div>
        {!ready ? (
          <Skeleton className="h-12 w-full" />
        ) : (
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <Meter
              label={t('contacts', { n: ready.labelled, required: ready.required.labelled })}
              value={ready.labelled}
              max={ready.required.labelled}
            />
            <Meter
              label={t('positives', { n: ready.positives, required: ready.required.positives })}
              value={ready.positives}
              max={ready.required.positives}
            />
            <p className="text-xs text-muted-foreground sm:col-span-2">
              {t('readinessHint', { horizon: ready.horizonDays, censored: ready.censored })}
            </p>
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2 rounded-lg border p-4">
          <h3 className="font-medium">{t('datasets')}</h3>
          {(datasets.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noDatasets')}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {(datasets.data ?? []).slice(0, 5).map((dataset) => (
                <li key={dataset.id} className="flex flex-wrap items-center gap-2">
                  <span className="mr-auto">
                    {offers(dataset.offer)} ·{' '}
                    {t('datasetCounts', { rows: dataset.counts.rows, positives: dataset.counts.positives })} ·{' '}
                    {format.dateTime(new Date(dataset.createdAt), { dateStyle: 'medium' })}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={actions.train.isPending}
                    onClick={() =>
                      void run(() => actions.train.mutateAsync(dataset.id), t('trainingQueued'), t('failed'))
                    }
                  >
                    {t('train')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-2 rounded-lg border p-4">
          <h3 className="font-medium">{t('runs')}</h3>
          {(runs.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noRuns')}</p>
          ) : (
            <ul className="space-y-2 text-sm" aria-live="polite">
              {(runs.data ?? []).slice(0, 5).map((item) => (
                <li key={item.id} className="space-y-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        item.status === 'failed'
                          ? 'destructive'
                          : item.status === 'succeeded'
                            ? 'secondary'
                            : 'outline'
                      }
                    >
                      {t(`runStatus.${item.status}`)}
                    </Badge>
                    <span className="text-muted-foreground">
                      {format.dateTime(new Date(item.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                  </p>
                  {item.error ? <p className="text-destructive">{item.error}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {models.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (models.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noModels')}</p>
      ) : (
        <div className="space-y-4">
          {(models.data ?? []).map((model) => (
            <ModelCard key={model.id} model={model}>
              <ShadowControl model={model} />
            </ModelCard>
          ))}
        </div>
      )}
      <Promotions />
    </section>
  );
}

function Meter({
  label,
  value,
  max,
}: {
  readonly label: string;
  readonly value: number;
  readonly max: number;
}) {
  return (
    <div className="space-y-1">
      <p>{label}</p>
      <Progress value={Math.min(100, (value / Math.max(1, max)) * 100)} aria-label={label} />
    </div>
  );
}

/** Run a model in shadow beside a profile of its offer, and (when it is) the comparison and promotion. */
function ShadowControl({ model }: { readonly model: MlModel }) {
  const t = useTranslations('scoringModels.shadow');
  const profiles = useScoringProfiles();
  const assignments = useShadowAssignments();
  const actions = useMlActions();
  const candidates = (profiles.data?.items ?? []).filter((p) => p.offer === model.offer && !p.archived);
  const assigned = (assignments.data ?? []).find((a) => a.modelId === model.id);
  if (model.status === 'retired' || model.status === 'rejected' || model.status === 'active') return null;
  const set = (profileId: string, modelId: string | null) =>
    run(
      () => actions.shadow.mutateAsync({ profileId, modelId }),
      modelId ? t('started') : t('stopped'),
      t('failed'),
    );
  return (
    <section className="space-y-3 rounded-lg border p-3 text-sm">
      <h4 className="font-medium">{t('title')}</h4>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`shadow-${model.id}`}>{t('profile')}</Label>
          <Select
            value={assigned?.profileId ?? NONE}
            onValueChange={(value) =>
              void (value === NONE ? assigned && set(assigned.profileId, null) : set(value, model.id))
            }
          >
            <SelectTrigger id={`shadow-${model.id}`} className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('none')}</SelectItem>
              {candidates.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      {assigned ? <Comparison profileId={assigned.profileId} model={model} /> : null}
    </section>
  );
}

function Criterion({ ok, label }: { readonly ok: boolean; readonly label: string }) {
  return (
    <li className="flex items-center gap-2">
      {ok ? (
        <CheckIcon aria-hidden className="size-4 text-emerald-700 dark:text-emerald-400" />
      ) : (
        <XIcon aria-hidden className="size-4 text-destructive" />
      )}
      <span>{label}</span>
      <span className="sr-only">{ok ? '✓' : '✗'}</span>
    </li>
  );
}

function Comparison({ profileId, model }: { readonly profileId: string; readonly model: MlModel }) {
  const t = useTranslations('scoringModels.comparison');
  const format = useFormatter();
  const comparison = useComparison(profileId);
  const actions = useMlActions();
  const [override, setOverride] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const data = comparison.data;
  if (!data) return <Skeleton className="h-24 w-full" />;
  const pct = (n: number | null) =>
    n === null ? '—' : format.number(n, { style: 'percent', maximumFractionDigits: 1 });
  const promote = (overrideReason?: string) =>
    run(
      () =>
        actions.promote.mutateAsync({
          profileId,
          modelId: model.id,
          ...(overrideReason ? { overrideReason } : {}),
        }),
      t('promoted'),
      t('failed'),
    );
  return (
    <div className="space-y-2">
      <p>
        {t('summary', {
          contacts: data.contacts,
          positives: data.positives,
          since: format.dateTime(new Date(data.since), { dateStyle: 'medium' }),
        })}
      </p>
      <p>
        {t('topRates', {
          active: pct(data.active.rate),
          shadow: pct(data.shadow.rate),
          lift: data.lift === null ? '—' : format.number(data.lift, { maximumFractionDigits: 2 }),
        })}
      </p>
      <ul className="space-y-1">
        <Criterion
          ok={data.enoughPositives}
          label={t('criteriaPositives', { min: data.criteria.minPositives })}
        />
        <Criterion ok={data.liftMet} label={t('criteriaLift', { min: data.criteria.minLift })} />
        <Criterion ok={data.intervalsSeparate} label={t('criteriaIntervals')} />
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!data.eligible || actions.promote.isPending} onClick={() => void promote()}>
          {t('promote')}
        </Button>
        {!data.eligible ? (
          <Button variant="outline" onClick={() => setOverride(true)}>
            {t('override')}
          </Button>
        ) : null}
      </div>
      <Dialog open={override} onOpenChange={setOverride}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('overrideTitle')}</DialogTitle>
            <DialogDescription>{t('overrideHint')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="override-reason">{t('reason')}</Label>
            <Textarea
              id="override-reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOverride(false)}>
              {t('cancel')}
            </Button>
            <Button
              disabled={reason.trim().length < 10 || actions.promote.isPending}
              onClick={() => {
                setOverride(false);
                void promote(reason.trim());
              }}
            >
              {t('overrideConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Promotions() {
  const t = useTranslations('scoringModels.promotions');
  const format = useFormatter();
  const promotions = usePromotions();
  const profiles = useScoringProfiles();
  const actions = useMlActions();
  const names = new Map((profiles.data?.items ?? []).map((p) => [p.id, p.name]));
  const items = promotions.data ?? [];
  if (items.length === 0) return null;
  const latestOpen = new Set<string>();
  const rollbackable = new Set<string>();
  for (const item of items)
    if (!item.rolledBackAt && !latestOpen.has(item.profileId)) {
      latestOpen.add(item.profileId);
      rollbackable.add(item.id);
    }
  return (
    <section className="space-y-2 rounded-lg border p-4 text-sm">
      <h3 className="font-medium">{t('title')}</h3>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-2">
            <span className="mr-auto">
              {t('line', {
                profile: names.get(item.profileId) ?? item.profileId,
                from: item.fromVersion,
                to: item.toVersion,
                when: format.dateTime(new Date(item.promotedAt), { dateStyle: 'medium' }),
              })}
              {item.overrideReason ? ` · ${t('overridden', { reason: item.overrideReason })}` : ''}
              {item.rolledBackAt ? ` · ${t('rolledBack')}` : ''}
            </span>
            {rollbackable.has(item.id) ? (
              <Button
                size="sm"
                variant="outline"
                disabled={actions.rollback.isPending}
                onClick={() =>
                  void run(() => actions.rollback.mutateAsync(item.profileId), t('done'), t('failed'))
                }
              >
                {t('rollback')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
