'use client';

import {
  MAX_PASTED_REVIEWS,
  MAX_REVIEW_CHARS,
  PAIN_SIGNAL_DEFINITIONS,
  PAIN_SIGNAL_TAGS,
  type ReviewInsights,
  type ReviewSource,
} from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@bf/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Label } from '@bf/ui/components/label';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Textarea } from '@bf/ui/components/textarea';
import { ClipboardPasteIcon, MessageSquareTextIcon, SparklesIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import type { BusinessTabProps } from '@/features/business/tabs/registry.ts';
import { useEnrich } from '@/features/enrichment/api.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { splitPastedReviews, useAnalyzePastedReviews, useReviewInsights } from './api.ts';

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

/** Pain signals by share of analysed reviews (largest first), as labelled bars. */
function PainChart({ insights }: { readonly insights: ReviewInsights }) {
  const t = useTranslations('reviews');
  const locale = useLocale() as 'en' | 'fr';
  const format = useFormatter();
  const rows = PAIN_SIGNAL_TAGS.filter((tag) => (insights.painCounts[tag] ?? 0) > 0).sort(
    (a, b) => (insights.painShare[b] ?? 0) - (insights.painShare[a] ?? 0),
  );
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t('noSignals')}</p>;
  return (
    <ul className="grid gap-3" aria-label={t('signalsTitle')}>
      {rows.map((tag) => {
        const share = insights.painShare[tag] ?? 0;
        const definition = PAIN_SIGNAL_DEFINITIONS[tag];
        return (
          <li key={tag} className="grid gap-1" data-testid={`pain-${tag}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-medium" title={definition.description[locale]}>
                {definition.label[locale]}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {t('signalValue', {
                  count: insights.painCounts[tag] ?? 0,
                  share: format.number(share, { style: 'percent', maximumFractionDigits: 0 }),
                })}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
              <div
                className={
                  definition.polarity === 'positive'
                    ? 'h-full rounded-full bg-emerald-600'
                    : 'h-full rounded-full bg-lagoon'
                }
                style={{ width: `${Math.max(2, Math.round(share * 100))}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Evidence({ insights }: { readonly insights: ReviewInsights }) {
  const t = useTranslations('reviews');
  const locale = useLocale() as 'en' | 'fr';
  const format = useFormatter();
  const tags = PAIN_SIGNAL_TAGS.filter((tag) => (insights.evidence[tag]?.length ?? 0) > 0);
  if (tags.length === 0) return <p className="text-sm text-muted-foreground">{t('noEvidence')}</p>;
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('evidenceHint')}</p>
      {tags.map((tag) => (
        <section key={tag} aria-labelledby={`evidence-${tag}`} className="grid gap-2">
          <h4 id={`evidence-${tag}`} className="text-sm font-medium">
            {PAIN_SIGNAL_DEFINITIONS[tag].label[locale]}
          </h4>
          <ul className="grid gap-2">
            {insights.evidence[tag]?.map((snippet) => (
              <li key={`${snippet.sourceRef}-${snippet.text}`} className="rounded-md border p-2 text-sm">
                <p>{snippet.text}</p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">{t(`sources.${snippet.sourceRef}`)}</Badge>
                  {snippet.expiresAt
                    ? t('keptUntil', {
                        date: format.dateTime(new Date(snippet.expiresAt), { dateStyle: 'medium' }),
                      })
                    : null}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function PasteDialog({
  businessId,
  open,
  onOpenChange,
}: {
  readonly businessId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('reviews.paste');
  const errorMessage = useErrorMessage();
  const analyze = useAnalyzePastedReviews(businessId);
  const [text, setText] = React.useState('');
  const reviews = splitPastedReviews(text, MAX_PASTED_REVIEWS, MAX_REVIEW_CHARS);
  const close = (next: boolean) => {
    if (!next) setText('');
    onOpenChange(next);
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await analyze.mutateAsync({ reviews: reviews.map((review) => ({ text: review })) });
      (await getToast()).success(t('done'));
      close(false);
    } catch (caught) {
      (await getToast()).error(errorMessage(caught));
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description', { max: MAX_PASTED_REVIEWS })}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="paste-reviews">{t('label')}</Label>
            <Textarea
              id="paste-reviews"
              rows={10}
              value={text}
              aria-describedby="paste-reviews-count"
              onChange={(event) => setText(event.target.value)}
            />
            <p id="paste-reviews-count" className="text-sm text-muted-foreground" aria-live="polite">
              {t('count', { count: reviews.length })}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={reviews.length === 0 || analyze.isPending}>
              {analyze.isPending ? t('analysing') : t('analyse')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const SENTIMENT_LABELS = (value: number) =>
  value <= -0.25 ? 'negative' : value >= 0.25 ? 'positive' : 'mixed';

/** Business page → Reviews (BF-029): aggregated, anonymous insights, never review quotes. */
export function ReviewsTab({ business }: BusinessTabProps) {
  const t = useTranslations('reviews');
  const format = useFormatter();
  const canWrite = usePermission('business:write');
  const query = useReviewInsights(business.id);
  const enrich = useEnrich(business.id);
  const labels = useErrorLabels();
  const [pasting, setPasting] = React.useState(false);

  if (query.isPending) return <Skeleton className="h-64 w-full" />;
  if (query.isError) {
    return (
      <ErrorState
        problem={toProblemLike(query.error, t('loadFailed'))}
        labels={labels}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const { insights, sources } = query.data;
  const effective = (source: ReviewSource) => sources.find((s) => s.source === source)?.effective !== 'none';
  const canFetch = effective('google_places') || effective('gmaps_scraper');
  const canPaste = effective('manual');

  const analyse = async () => {
    try {
      await enrich.mutateAsync({ steps: ['reviews'], force: true, key: `reviews-${crypto.randomUUID()}` });
      (await getToast()).success(t('analysisStarted'));
    } catch {
      (await getToast()).error(t('analysisFailed'));
    }
  };

  const actions = canWrite ? (
    <div className="flex flex-wrap gap-2">
      {canFetch ? (
        <Button type="button" size="sm" disabled={enrich.isPending} onClick={() => void analyse()}>
          <SparklesIcon aria-hidden />
          {t('analyse')}
        </Button>
      ) : null}
      {canPaste ? (
        <Button type="button" size="sm" variant="outline" onClick={() => setPasting(true)}>
          <ClipboardPasteIcon aria-hidden />
          {t('pasteButton')}
        </Button>
      ) : null}
    </div>
  ) : null;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">{t('title')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
          {actions}
        </CardHeader>
        {insights ? (
          <CardContent>
            <dl className="divide-y">
              <Fact label={t('sampleSize')}>{t('reviewCount', { count: insights.sampleSize })}</Fact>
              <Fact label={t('sourcesLabel')}>
                <span className="inline-flex flex-wrap justify-end gap-1">
                  {insights.sources.map((source) => (
                    <Badge key={source} variant="outline">
                      {t(`sources.${source}`)}
                    </Badge>
                  ))}
                </span>
              </Fact>
              <Fact label={t('sentiment')}>
                {insights.sentimentAvg === null
                  ? t('unknown')
                  : t(`sentiments.${SENTIMENT_LABELS(insights.sentimentAvg)}`, {
                      value: format.number(insights.sentimentAvg, {
                        maximumFractionDigits: 2,
                        signDisplay: 'exceptZero',
                      }),
                    })}
              </Fact>
              <Fact label={t('ownerResponseRate')}>
                {insights.ownerResponseRate === null
                  ? t('unknown')
                  : format.number(insights.ownerResponseRate, { style: 'percent', maximumFractionDigits: 0 })}
              </Fact>
              <Fact label={t('rating')}>
                {insights.ratingSnapshot
                  ? t('ratingValue', {
                      avg: format.number(insights.ratingSnapshot.avg, { maximumFractionDigits: 1 }),
                      count: insights.ratingSnapshot.count,
                    })
                  : t('unknown')}
              </Fact>
              <Fact label={t('ratingTrend')}>{t(`trends.${insights.ratingTrend}`)}</Fact>
              <Fact label={t('computedAt')}>{format.relativeTime(new Date(insights.computedAt))}</Fact>
              {insights.expiresAt ? (
                <Fact label={t('expiresAt')}>
                  {format.dateTime(new Date(insights.expiresAt), { dateStyle: 'medium' })}
                </Fact>
              ) : null}
            </dl>
          </CardContent>
        ) : null}
      </Card>

      {insights ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('signalsTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <PainChart insights={insights} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('evidenceTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Evidence insights={insights} />
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">
            {insights.sources.includes('google_places') ? `${t('googleAttribution')} ` : ''}
            {t('usagePolicy')}
          </p>
        </>
      ) : (
        <EmptyState
          icon={<MessageSquareTextIcon aria-hidden />}
          title={t('emptyTitle')}
          description={canFetch ? t('emptyFetch') : t('emptyNoSources')}
          action={
            canFetch ? undefined : (
              <Button asChild variant="outline" size="sm">
                <Link href="/settings/integrations#review-sources">{t('settingsLink')}</Link>
              </Button>
            )
          }
        />
      )}
      <PasteDialog businessId={business.id} open={pasting} onOpenChange={setPasting} />
    </div>
  );
}
