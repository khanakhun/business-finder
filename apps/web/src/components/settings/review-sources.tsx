'use client';

import type { ReviewSourceGate } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { ErrorState } from '@bf/ui/components/error-state';
import { Label } from '@bf/ui/components/label';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Switch } from '@bf/ui/components/switch';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { useReviewSources, useUpdateReviewSources } from '@/features/reviews/api.ts';
import { useSession } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { SettingsSection } from './section.tsx';

function GateStatus({ gate }: { readonly gate: ReviewSourceGate }) {
  const t = useTranslations('integrations.reviews');
  return gate.effective === 'none' ? (
    <Badge variant="outline">{t(`blockedBy.${gate.blockedBy ?? 'not_enabled'}`)}</Badge>
  ) : (
    <Badge>{t('active')}</Badge>
  );
}

/**
 * Settings → Integrations → Review sources (BF-029): which reviews may feed insights. Google needs an owner's
 * acknowledgement of the terms warning; the scraper needs the workspace's opt-in and its own gates; pasted reviews
 * are always allowed (analysed on the fly, never kept).
 */
export function ReviewSourcesSettings() {
  const t = useTranslations('integrations.reviews');
  const locale = useLocale() as 'en' | 'fr';
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const labels = useErrorLabels();
  const owner = useSession().role === 'owner';
  const status = useReviewSources();
  const update = useUpdateReviewSources();
  const [open, setOpen] = React.useState(false);
  const [accepted, setAccepted] = React.useState(false);
  // Consent is given afresh each time: closing the dialog clears the box.
  const close = () => {
    setOpen(false);
    setAccepted(false);
  };
  const change = async (input: Parameters<typeof update.mutateAsync>[0]) => {
    try {
      await update.mutateAsync(input);
      (await getToast()).success(t('saved'));
      close();
    } catch (caught) {
      (await getToast()).error(errorMessage(caught));
    }
  };

  if (status.isPending) return <Skeleton className="h-48 max-w-3xl" />;
  if (status.isError) {
    return (
      <ErrorState
        problem={toProblemLike(status.error, t('loadFailed'))}
        labels={labels}
        onRetry={() => void status.refetch()}
      />
    );
  }
  const data = status.data;
  const gate = (source: ReviewSourceGate['source']) =>
    data.sources.find((s) => s.source === source) as ReviewSourceGate;
  const google = gate('google_places');
  const scraper = gate('gmaps_scraper');
  return (
    <SettingsSection id="review-sources" title={t('title')} description={t('description')}>
      <ul className="grid gap-4">
        <li className="grid gap-2 rounded-md border border-destructive/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">{t('google.title')}</h3>
            <GateStatus gate={google} />
          </div>
          <p className="text-sm text-muted-foreground">{t('google.summary')}</p>
          <p className="text-sm text-muted-foreground">
            {data.googleAcknowledgement
              ? t('google.acknowledged', {
                  date: format.dateTime(new Date(data.googleAcknowledgement.acknowledgedAt), {
                    dateStyle: 'medium',
                  }),
                })
              : t('google.notAcknowledged')}
          </p>
          {owner ? (
            data.googleAcknowledgement ? (
              <Button
                variant="outline"
                className="w-fit"
                disabled={update.isPending}
                onClick={() => void change({ kind: 'revoke' })}
              >
                {t('google.revoke')}
              </Button>
            ) : (
              <Button variant="destructive" className="w-fit" onClick={() => setOpen(true)}>
                {t('google.enable')}
              </Button>
            )
          ) : (
            <p className="text-sm text-muted-foreground">{t('google.ownerOnly')}</p>
          )}
        </li>
        <li className="grid gap-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="review-scraper" className="font-medium">
              {t('scraper.title')}
            </Label>
            <div className="flex items-center gap-2">
              <GateStatus gate={scraper} />
              <Switch
                id="review-scraper"
                checked={scraper.usage !== 'none'}
                disabled={update.isPending}
                aria-describedby="review-scraper-hint"
                onCheckedChange={(checked) =>
                  void change({
                    kind: 'scraper',
                    body: { gmapsScraper: checked ? 'transient_insights' : 'none' },
                  })
                }
              />
            </div>
          </div>
          <p id="review-scraper-hint" className="text-sm text-muted-foreground">
            {t('scraper.summary')}
          </p>
        </li>
        <li className="grid gap-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">{t('manual.title')}</h3>
            <GateStatus gate={gate('manual')} />
          </div>
          <p className="text-sm text-muted-foreground">{t('manual.summary')}</p>
        </li>
      </ul>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('google.dialogTitle')}</DialogTitle>
            <DialogDescription>{data.googleTerms.warning[locale]}</DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            <a
              href={data.googleTerms.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-lagoon underline underline-offset-2"
            >
              {t('google.termsLink', {
                date: format.dateTime(new Date(data.googleTerms.lastModified), { dateStyle: 'long' }),
              })}
            </a>
          </p>
          <div className="flex items-start gap-2">
            <Checkbox
              id="google-reviews-accept"
              checked={accepted}
              onCheckedChange={(v) => setAccepted(v === true)}
            />
            <Label htmlFor="google-reviews-accept" className="leading-snug">
              {t('google.accept')}
            </Label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={!accepted || update.isPending}
              onClick={() => void change({ kind: 'acknowledge', termsVersion: data.googleTerms.version })}
            >
              {t('google.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
