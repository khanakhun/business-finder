'use client';

import {
  type BusinessScore,
  FEATURE_DEFINITIONS,
  type ScoreContribution,
  type ScoringProfileSummary,
} from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@bf/ui/components/card';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { GaugeIcon, MinusCircleIcon, PlusCircleIcon, RefreshCwIcon } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import type { BusinessTabProps } from '@/features/business/tabs/registry.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useBusinessScores, useRecomputeBusinessScores, useScoringProfiles } from './api.ts';
import { OFFER_ICON, type OfferId, ScoreBadge, type Tier } from './score-badge.tsx';
import { Waterfall, waterfallSteps } from './waterfall.tsx';

// The business's Scores tab (BF-032): one card per profile of the workspace, primary first — score, tier, why
// (reasons), how (waterfall and contributions), the gate that decided, and a recompute button.

type Locale = 'en' | 'fr';

const label = (feature: ScoreContribution['feature'], locale: Locale) =>
  FEATURE_DEFINITIONS[feature].label[locale];

const value = (raw: ScoreContribution['rawValue'], t: (key: 'yes' | 'no' | 'missing') => string) =>
  raw === null ? t('missing') : raw === true ? t('yes') : raw === false ? t('no') : String(raw);

function ScoreCard({
  score,
  profile,
  locale,
}: {
  readonly score: BusinessScore;
  readonly profile: ScoringProfileSummary | undefined;
  readonly locale: Locale;
}) {
  const t = useTranslations('scoring.tab');
  const offers = useTranslations('scoring.offers');
  const format = useFormatter();
  const Icon = OFFER_ICON[score.offer as OfferId];
  const steps = waterfallSteps(score.contributions, score.score, (f) => label(f, locale), t('total'));
  const positive = score.reasons.filter((reason) => reason.direction === 'positive');
  const negative = score.reasons.filter((reason) => reason.direction === 'negative');
  const shown = score.contributions.filter((c) => c.contribution !== 0 || c.rawValue !== null);
  return (
    <Card data-testid={`score-card-${score.offer}`}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon aria-hidden className="size-4" />
            {profile?.name ?? offers(score.offer)}
            {profile?.primary ? <Badge variant="secondary">{t('primary')}</Badge> : null}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t('meta', {
              version: score.profileVersion,
              when: format.relativeTime(new Date(score.computedAt)),
            })}
          </p>
        </div>
        <ScoreBadge
          score={score.score}
          tier={score.tier as Tier}
          offer={score.offer as OfferId}
          className="text-base"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        {score.gated ? (
          <p
            role="note"
            className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm"
            data-testid="score-gate"
          >
            {score.gated.applied
              ? t(score.gated.effect === 'exclude' ? 'gateExcluded' : 'gateCapped', {
                  reason: score.gated.reason[locale],
                })
              : t('gateNote', { reason: score.gated.reason[locale] })}
          </p>
        ) : null}
        {positive.length + negative.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2">
            <section aria-labelledby={`why-${score.profileId}`}>
              <h3 id={`why-${score.profileId}`} className="mb-2 text-sm font-medium">
                {t('for')}
              </h3>
              <ul className="space-y-1 text-sm">
                {positive.map((reason) => (
                  <li key={reason.feature} className="flex gap-2">
                    <PlusCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                    {reason.text[locale]}
                  </li>
                ))}
              </ul>
            </section>
            <section aria-labelledby={`against-${score.profileId}`}>
              <h3 id={`against-${score.profileId}`} className="mb-2 text-sm font-medium">
                {t('against')}
              </h3>
              {negative.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {negative.map((reason) => (
                    <li key={reason.feature} className="flex gap-2">
                      <MinusCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-red-600" />
                      {reason.text[locale]}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('nothingAgainst')}</p>
              )}
            </section>
          </div>
        ) : null}
        <Waterfall steps={steps} />
        <details>
          <summary className="cursor-pointer text-sm font-medium">{t('details')}</summary>
          <table className="mt-2 w-full text-sm" data-testid="score-contributions">
            <caption className="sr-only">{t('tableCaption')}</caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="py-1 font-normal">
                  {t('feature')}
                </th>
                <th scope="col" className="py-1 font-normal">
                  {t('value')}
                </th>
                <th scope="col" className="py-1 text-right font-normal">
                  {t('weight')}
                </th>
                <th scope="col" className="py-1 text-right font-normal">
                  {t('contribution')}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((contribution) => (
                <tr key={contribution.feature} className="border-t border-border">
                  <th
                    scope="row"
                    className="py-1 text-left font-normal"
                    title={FEATURE_DEFINITIONS[contribution.feature].description[locale]}
                  >
                    {label(contribution.feature, locale)}
                  </th>
                  <td className="py-1">
                    {value(contribution.rawValue, (key) => t(key))}
                    {contribution.imputed ? (
                      <span className="text-muted-foreground"> ({t(`imputed.${contribution.imputed}`)})</span>
                    ) : null}
                  </td>
                  <td className="py-1 text-right tabular-nums">{contribution.weight}</td>
                  <td className="py-1 text-right tabular-nums">
                    {contribution.contribution > 0 ? '+' : ''}
                    {format.number(contribution.contribution, { maximumFractionDigits: 1 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </CardContent>
    </Card>
  );
}

export function ScoresTab({ business }: BusinessTabProps) {
  const t = useTranslations('scoring.tab');
  const labels = useErrorLabels();
  const locale = (useLocale() === 'fr' ? 'fr' : 'en') as Locale;
  const canRecompute = usePermission('business:write');
  const scores = useBusinessScores(business.id);
  const profiles = useScoringProfiles();
  const recompute = useRecomputeBusinessScores(business.id);

  const action = canRecompute ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={recompute.isPending}
      onClick={async () => {
        try {
          await recompute.mutateAsync();
          (await getToast()).success(t('recomputed'));
        } catch {
          (await getToast()).error(t('recomputeFailed'));
        }
      }}
    >
      <RefreshCwIcon aria-hidden />
      {t('recompute')}
    </Button>
  ) : null;

  if (scores.isPending) return <Skeleton className="h-64 w-full" />;
  if (scores.isError) {
    return (
      <ErrorState
        problem={toProblemLike(scores.error, t('loadFailed'))}
        labels={labels}
        onRetry={() => void scores.refetch()}
      />
    );
  }
  const byId = new Map((profiles.data?.items ?? []).map((profile) => [profile.id, profile]));
  const items = [...scores.data.items].sort(
    (a, b) =>
      Number(byId.get(b.profileId)?.primary ?? false) - Number(byId.get(a.profileId)?.primary ?? false),
  );
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<GaugeIcon aria-hidden />}
        title={t('emptyTitle')}
        description={t('emptyDescription')}
        action={action}
      />
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex justify-end">{action}</div>
      {items.map((score) => (
        <ScoreCard key={score.profileId} score={score} profile={byId.get(score.profileId)} locale={locale} />
      ))}
    </div>
  );
}
