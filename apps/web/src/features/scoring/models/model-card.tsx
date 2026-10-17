'use client';

import type { MlMetrics, MlModel } from '@bf/contracts';
import { FEATURE_DEFINITIONS, type FeatureKey } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toProblemLike } from '@/components/states/problem.ts';
import { getToast } from '@/lib/toast.tsx';
import { useMlActions, useModelImportance, useMonitoring } from './api.ts';

// A model version (BF-059): its metrics against the rule score at the same contacts, the calibration plot, the
// lift, what drives it, its warnings, and its drift and decay checks.

const METRICS = ['rocAuc', 'prAuc', 'brier', 'liftTop10', 'liftTop20'] as const;

const STATUS: Record<MlModel['status'], 'secondary' | 'outline' | 'destructive' | 'default'> = {
  trained: 'outline',
  shadow: 'secondary',
  active: 'default',
  retired: 'outline',
  rejected: 'destructive',
};

export function ModelCard({
  model,
  children,
}: {
  readonly model: MlModel;
  readonly children?: React.ReactNode;
}) {
  const t = useTranslations('scoringModels.card');
  const status = useTranslations('scoringModels.status');
  const format = useFormatter();
  const value = (metrics: MlMetrics, key: (typeof METRICS)[number]) => {
    const n = metrics[key];
    return n === null ? '—' : format.number(n, { maximumFractionDigits: 3 });
  };
  const calibration = model.metrics.calibration.map((bin) => ({
    predicted: Math.round(bin.predicted * 1000) / 1000,
    observed: bin.observed,
    n: bin.n,
  }));
  const lift = [
    { k: '10%', model: model.metrics.liftTop10, rules: model.baselineMetrics.liftTop10 },
    { k: '20%', model: model.metrics.liftTop20, rules: model.baselineMetrics.liftTop20 },
  ];
  return (
    <article className="space-y-4 rounded-lg border p-4" aria-labelledby={`model-${model.id}`}>
      <header className="flex flex-wrap items-center gap-2">
        <h3 id={`model-${model.id}`} className="mr-auto text-base font-semibold">
          {t('title', { version: model.version, kind: model.kind === 'logreg' ? t('logreg') : t('hgb') })}
        </h3>
        <Badge variant={STATUS[model.status]}>{status(model.status)}</Badge>
        <span className="text-xs text-muted-foreground">
          {format.dateTime(new Date(model.trainedAt), { dateStyle: 'medium' })}
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{t('metrics')}</caption>
          <thead>
            <tr>
              <th scope="col" className="border-b px-2 py-1 font-medium">
                {t('metric')}
              </th>
              <th scope="col" className="border-b px-2 py-1 font-medium">
                {t('model')}
              </th>
              <th scope="col" className="border-b px-2 py-1 font-medium">
                {t('rules')}
              </th>
            </tr>
          </thead>
          <tbody>
            {METRICS.map((key) => (
              <tr key={key}>
                <th scope="row" className="border-b px-2 py-1 font-normal">
                  {t(`metrics_${key}`)}
                </th>
                <td className="border-b px-2 py-1 tabular-nums">{value(model.metrics, key)}</td>
                <td className="border-b px-2 py-1 tabular-nums">{value(model.baselineMetrics, key)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('spearman', {
          value: model.spearman === null ? '—' : format.number(model.spearman, { maximumFractionDigits: 2 }),
        })}
      </p>
      {model.warnings.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-amber-700 dark:text-amber-400">
          {model.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <figure className="space-y-1">
          <figcaption className="text-sm font-medium">{t('calibration')}</figcaption>
          <div className="h-48" role="img" aria-label={t('calibrationSummary')}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={calibration} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="predicted" type="number" domain={[0, 1]} tick={{ fontSize: 10 }} />
                <YAxis domain={[0, 1]} tick={{ fontSize: 10 }} />
                <Tooltip />
                <ReferenceLine
                  segment={[
                    { x: 0, y: 0 },
                    { x: 1, y: 1 },
                  ]}
                  stroke="currentColor"
                  strokeDasharray="4 4"
                />
                <Line dataKey="observed" name={t('observed')} stroke="var(--color-lagoon, #0e7490)" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </figure>
        <figure className="space-y-1">
          <figcaption className="text-sm font-medium">{t('lift')}</figcaption>
          <div className="h-48" role="img" aria-label={t('liftSummary')}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={lift} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="k" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="model" name={t('model')} fill="var(--color-lagoon, #0e7490)" />
                <Bar dataKey="rules" name={t('rules')} fill="var(--color-coral, #f97316)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </figure>
      </div>
      <Drivers model={model} />
      <DriftPanel model={model} />
      {children}
    </article>
  );
}

function Drivers({ model }: { readonly model: MlModel }) {
  const t = useTranslations('scoringModels.card');
  const locale = useLocale() === 'fr' ? 'fr' : 'en';
  const format = useFormatter();
  const importance = useModelImportance(model.id);
  if (model.kind !== 'logreg') return <p className="text-sm text-muted-foreground">{t('noDrivers')}</p>;
  if (!importance.data) return <Skeleton className="h-16 w-full" />;
  const label = (feature: string) => FEATURE_DEFINITIONS[feature as FeatureKey]?.label[locale] ?? feature;
  return (
    <section className="space-y-1">
      <h4 className="text-sm font-medium">{t('drivers')}</h4>
      <ul className="grid gap-1 text-sm sm:grid-cols-2">
        {importance.data.slice(0, 10).map((item) => (
          <li key={item.feature} className="flex items-center gap-2">
            <span
              className={item.weight >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}
            >
              {item.weight >= 0 ? '▲' : '▼'}
            </span>
            <span className="mr-auto">{label(item.feature)}</span>
            <span className="tabular-nums text-muted-foreground">
              {format.number(item.weight, { maximumFractionDigits: 2, signDisplay: 'always' })}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t('driversHint')}</p>
    </section>
  );
}

function DriftPanel({ model }: { readonly model: MlModel }) {
  const t = useTranslations('scoringModels.drift');
  const format = useFormatter();
  const monitoring = useMonitoring(model.id);
  const actions = useMlActions();
  if (model.status !== 'active' && model.status !== 'shadow') return null;
  const check = async () => {
    const toast = await getToast();
    try {
      const result = await actions.monitor.mutateAsync(model.id);
      toast.success(result.alerts.length ? t('alerts', { count: result.alerts.length }) : t('noAlerts'));
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  const latest = monitoring.data;
  return (
    <section className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="mr-auto font-medium">{t('title')}</h4>
        <Button variant="outline" size="sm" onClick={() => void check()} disabled={actions.monitor.isPending}>
          {t('checkNow')}
        </Button>
      </div>
      {!latest ? (
        <p className="text-muted-foreground">{t('never')}</p>
      ) : (
        <>
          <p className="text-muted-foreground">
            {t('checked', { when: format.relativeTime(new Date(latest.at)) })}
          </p>
          {latest.alerts.length > 0 ? (
            <ul className="list-disc pl-5 text-destructive">
              {latest.alerts.map((alert) => (
                <li key={alert}>{alert}</li>
              ))}
            </ul>
          ) : (
            <p>{t('stable')}</p>
          )}
          <p>
            {t('auc', {
              now: latest.auc === null ? '—' : format.number(latest.auc, { maximumFractionDigits: 3 }),
              before:
                latest.validationAuc === null
                  ? '—'
                  : format.number(latest.validationAuc, { maximumFractionDigits: 3 }),
              n: latest.recentContacts,
            })}
          </p>
          {latest.featurePsi.length > 0 ? (
            <ul className="grid gap-1 sm:grid-cols-2">
              {latest.featurePsi.slice(0, 8).map((item) => (
                <li key={item.feature} className="flex gap-2">
                  <span className="mr-auto">
                    {item.feature}
                    {item.top ? ` ${t('top')}` : ''}
                  </span>
                  <span className={`tabular-nums ${item.psi > 0.25 ? 'text-destructive' : ''}`}>
                    {format.number(item.psi, { maximumFractionDigits: 2 })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">{t('notEnoughRecent')}</p>
          )}
        </>
      )}
    </section>
  );
}
