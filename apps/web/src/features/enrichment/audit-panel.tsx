'use client';

import {
  FINDING_DEFINITIONS,
  FINDING_SEVERITIES,
  type Finding,
  type MetricName,
  metricRating,
  type PsiStrategyResult,
  VISION_CRITERIA,
  type WebsiteAudit,
  type WebsiteStatus,
} from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@bf/ui/components/card';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { cn } from '@bf/ui/lib/utils';
import { GaugeIcon } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useEnrich, useWebsiteAudit } from './api.ts';

// Website tab → audit (BF-030): quality gauge and status, PageSpeed (mobile/desktop) with Web Vitals ratings, the
// visual grade with its evidence, and findings grouped by severity with recommendations — EN/FR.

const STATUS_TONE: Readonly<Record<WebsiteStatus, string>> = {
  none: 'bg-muted text-muted-foreground',
  parked: 'bg-destructive/15 text-destructive',
  social_only: 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
  broken: 'bg-destructive/15 text-destructive',
  weak: 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
  ok: 'bg-lagoon/15 text-lagoon',
  strong: 'bg-emerald-600/15 text-emerald-800 dark:text-emerald-200',
};

const RATING_TONE = {
  good: 'text-emerald-800 dark:text-emerald-200',
  needs_improvement: 'text-amber-800 dark:text-amber-200',
  poor: 'text-destructive',
} as const;

/** Lighthouse category colours: ≥ 90 good, 50–89 needs improvement, < 50 poor. */
const scoreRating = (value: number) => (value >= 90 ? 'good' : value >= 50 ? 'needs_improvement' : 'poor');

const SEVERITY_TONE: Readonly<Record<Finding['severity'], string>> = {
  critical: 'border-destructive/50 bg-destructive/5',
  major: 'border-amber-500/50 bg-amber-500/5',
  minor: 'border-border',
  info: 'border-dashed border-border',
};

function Gauge({ value, label }: { readonly value: number | null; readonly label: string }) {
  const circumference = 2 * Math.PI * 34;
  const filled = value === null ? 0 : (value / 100) * circumference;
  const tone = value === null ? 'text-muted-foreground' : RATING_TONE[scoreRating(value)];
  return (
    <div className="relative size-24 shrink-0" role="img" aria-label={label}>
      <svg viewBox="0 0 80 80" className="size-24 -rotate-90" aria-hidden>
        <circle cx="40" cy="40" r="34" className="fill-none stroke-muted" strokeWidth="8" />
        <circle
          cx="40"
          cy="40"
          r="34"
          className={cn('fill-none stroke-current', tone)}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
        />
      </svg>
      <span
        className={cn('absolute inset-0 grid place-items-center text-2xl font-semibold tabular-nums', tone)}
      >
        {value ?? '—'}
      </span>
    </div>
  );
}

const METRICS: ReadonlyArray<{ readonly name: MetricName; readonly seconds: boolean }> = [
  { name: 'lcpMs', seconds: true },
  { name: 'cls', seconds: false },
  { name: 'inpMs', seconds: false },
  { name: 'tbtMs', seconds: false },
  { name: 'fcpMs', seconds: true },
  { name: 'speedIndexMs', seconds: true },
  { name: 'ttfbMs', seconds: false },
];

function PsiCard({ title, result }: { readonly title: string; readonly result: PsiStrategyResult | null }) {
  const t = useTranslations('enrichment.audit.psi');
  const format = useFormatter();
  if (!result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">{t('notMeasured')}</CardContent>
      </Card>
    );
  }
  const scores = [
    ['performance', result.scores.performance],
    ['accessibility', result.scores.accessibility],
    ['bestPractices', result.scores.bestPractices],
    ['seo', result.scores.seo],
  ] as const;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {scores.map(([key, value]) => (
            <li key={key} className="rounded-md border p-2 text-center">
              <span
                className={cn(
                  'block text-xl font-semibold tabular-nums',
                  value === null ? 'text-muted-foreground' : RATING_TONE[scoreRating(value)],
                )}
              >
                {value ?? '—'}
              </span>
              <span className="text-xs text-muted-foreground">{t(`categories.${key}`)}</span>
            </li>
          ))}
        </ul>
        <dl className="divide-y text-sm">
          {METRICS.map(({ name, seconds }) => {
            const value = result.metrics[name];
            if (value === null) return null;
            const rating = metricRating(name, value);
            const shown =
              name === 'cls'
                ? format.number(value, { maximumFractionDigits: 2 })
                : seconds
                  ? t('seconds', { value: format.number(value / 1000, { maximumFractionDigits: 1 }) })
                  : t('milliseconds', { value: format.number(Math.round(value)) });
            return (
              <div key={name} className="flex flex-wrap justify-between gap-2 py-1.5">
                <dt className="text-muted-foreground">{t(`metrics.${name}`)}</dt>
                <dd className={cn('font-medium tabular-nums', RATING_TONE[rating])}>
                  {shown} · {t(`ratings.${rating}`)}
                </dd>
              </div>
            );
          })}
        </dl>
        {result.opportunities.length > 0 ? (
          <div className="space-y-1.5">
            <h4 className="text-sm font-medium">{t('opportunities')}</h4>
            <ul className="space-y-1 text-sm">
              {result.opportunities.map((opportunity) => (
                <li key={opportunity.id} className="flex flex-wrap justify-between gap-2">
                  <span>{opportunity.title}</span>
                  {opportunity.savingsMs ? (
                    <span className="tabular-nums text-muted-foreground">
                      {t('savings', {
                        value: format.number(opportunity.savingsMs / 1000, { maximumFractionDigits: 1 }),
                      })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function VisionCard({ audit }: { readonly audit: WebsiteAudit }) {
  const t = useTranslations('enrichment.audit.vision');
  const locale = useLocale() as 'en' | 'fr';
  if (!audit.vision) {
    return (
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">{t('notGraded')}</CardContent>
      </Card>
    );
  }
  const vision = audit.vision;
  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <Badge variant="outline">{t('overall', { value: vision.overall })}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">{vision.summary[locale]}</p>
        <ul className="grid gap-3 md:grid-cols-2" aria-label={t('criteriaLabel')}>
          {VISION_CRITERIA.map((criterion) => {
            const { score, evidence } = vision.criteria[criterion];
            const rating = score >= 7 ? 'good' : score >= 4 ? 'needs_improvement' : 'poor';
            return (
              <li key={criterion} className="grid gap-1" data-testid={`vision-${criterion}`}>
                <div className="flex justify-between gap-2 text-sm">
                  <span className="font-medium">{t(`criteria.${criterion}`)}</span>
                  <span className={cn('tabular-nums', RATING_TONE[rating])}>{score}/10</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div
                    className={cn(
                      'h-full rounded-full',
                      rating === 'good'
                        ? 'bg-emerald-600'
                        : rating === 'poor'
                          ? 'bg-destructive'
                          : 'bg-amber-500',
                    )}
                    style={{ width: `${score * 10}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">{evidence}</p>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function Findings({ findings }: { readonly findings: readonly Finding[] }) {
  const t = useTranslations('enrichment.audit.findings');
  const locale = useLocale() as 'en' | 'fr';
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">{t('title', { count: findings.length })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {findings.length === 0 ? <p className="text-sm text-muted-foreground">{t('none')}</p> : null}
        {FINDING_SEVERITIES.map((severity) => {
          const group = findings.filter((finding) => finding.severity === severity);
          if (group.length === 0) return null;
          return (
            <section key={severity} aria-labelledby={`findings-${severity}`} className="space-y-2">
              <h4 id={`findings-${severity}`} className="text-sm font-medium">
                {t(`severities.${severity}`)} ({group.length})
              </h4>
              <ul className="grid gap-2">
                {group.map((finding) => {
                  const definition = FINDING_DEFINITIONS[finding.code];
                  return (
                    <li
                      key={finding.code}
                      className={cn('rounded-md border p-3 text-sm', SEVERITY_TONE[severity])}
                      data-testid={`finding-${finding.code}`}
                    >
                      <p className="font-medium">{definition.title[locale]}</p>
                      <p className="text-muted-foreground">{definition.explanation[locale]}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('evidence')} {finding.evidence}
                      </p>
                      <p className="mt-1">
                        <span className="font-medium">{t('recommendation')}</span>{' '}
                        {definition.recommendation[locale]}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}

/** The latest audit of the business website, with "Re-run audit". */
export function AuditPanel({
  businessId,
  hasWebsite,
}: {
  readonly businessId: string;
  readonly hasWebsite: boolean;
}) {
  const t = useTranslations('enrichment.audit');
  const format = useFormatter();
  const labels = useErrorLabels();
  const canWrite = usePermission('business:write');
  const query = useWebsiteAudit(businessId);
  const enrich = useEnrich(businessId);

  const rerun = async () => {
    try {
      // The visual audit brings its dependencies (crawl, PageSpeed) with it.
      await enrich.mutateAsync({ steps: ['vision_audit'], force: true, key: `audit-${crypto.randomUUID()}` });
      (await getToast()).success(t('started'));
    } catch {
      (await getToast()).error(t('failed'));
    }
  };
  const action =
    canWrite && hasWebsite ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={enrich.isPending}
        onClick={() => void rerun()}
      >
        <GaugeIcon aria-hidden />
        {query.data?.audit ? t('rerun') : t('run')}
      </Button>
    ) : null;

  if (query.isPending) return <Skeleton className="h-40 w-full" />;
  if (query.isError) {
    return (
      <ErrorState
        problem={toProblemLike(query.error, t('loadFailed'))}
        labels={labels}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const audit = query.data.audit;
  if (!audit) {
    return (
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">{t('title')}</CardTitle>
            <p className="text-sm text-muted-foreground">{hasWebsite ? t('empty') : t('noWebsite')}</p>
          </div>
          {action}
        </CardHeader>
      </Card>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Gauge
              value={audit.qualityScore}
              label={
                audit.qualityScore === null
                  ? t('qualityUnknown')
                  : t('qualityLabel', { value: audit.qualityScore })
              }
            />
            <div className="space-y-1.5">
              <CardTitle className="text-base">{t('title')}</CardTitle>
              <span
                className={cn(
                  'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
                  STATUS_TONE[audit.websiteStatus],
                )}
                data-testid="website-status"
              >
                {t(`statuses.${audit.websiteStatus}`)}
              </span>
              <p className="text-xs text-muted-foreground">
                {t('auditedAt', { when: format.relativeTime(new Date(audit.updatedAt)) })}
              </p>
            </div>
          </div>
          {action}
        </CardHeader>
      </Card>
      <PsiCard title={t('psi.mobile')} result={audit.psi?.mobile ?? null} />
      <PsiCard title={t('psi.desktop')} result={audit.psi?.desktop ?? null} />
      <VisionCard audit={audit} />
      <Findings findings={audit.findings} />
    </div>
  );
}
