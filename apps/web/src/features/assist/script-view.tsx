'use client';

import { OFFERS } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { RefreshCwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { getToast } from '@/lib/toast.tsx';
import { useCallScript } from './api.ts';

/** The call script (BF-057): opener, observations, preview mention, questions, objections, next step, reminders. */
export function ScriptView({
  businessId,
  idPrefix,
}: {
  readonly businessId: string;
  readonly idPrefix: string;
}) {
  const t = useTranslations('assist.script');
  const offers = useTranslations('composer.offers');
  const [offer, setOffer] = React.useState<string>('website_redesign');
  const [locale, setLocale] = React.useState<'en' | 'fr' | 'auto'>('auto');
  const { query, regenerate } = useCallScript(businessId, offer, locale, true);
  const again = async () => {
    try {
      await regenerate.mutateAsync();
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      (await getToast()).error(problem.detail ?? problem.title);
    }
  };
  const script = query.data;
  return (
    <section className="space-y-3 text-sm" aria-labelledby={`${idPrefix}-script`}>
      <div className="flex flex-wrap items-end gap-2">
        <h3 id={`${idPrefix}-script`} className="mr-auto text-base font-semibold">
          {t('title')}
        </h3>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-offer`}>{t('offer')}</Label>
          <Select value={offer} onValueChange={setOffer}>
            <SelectTrigger id={`${idPrefix}-offer`} className="w-48">
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
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-locale`}>{t('language')}</Label>
          <Select value={locale} onValueChange={(value) => setLocale(value as typeof locale)}>
            <SelectTrigger id={`${idPrefix}-locale`} className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('auto')}</SelectItem>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="fr">Français</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          onClick={() => void again()}
          disabled={regenerate.isPending || query.isLoading}
        >
          <RefreshCwIcon aria-hidden />
          {t('regenerate')}
        </Button>
      </div>
      {query.isLoading || regenerate.isPending ? (
        <div className="space-y-2" aria-busy="true">
          <p className="text-muted-foreground">{t('writing')}</p>
          <Skeleton className="h-24 w-full" />
        </div>
      ) : !script ? (
        <div className="space-y-2 rounded-lg border p-3">
          <p>{toProblemLike(query.error, t('failed')).detail ?? t('failed')}</p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {script.cached ? <p className="text-xs text-muted-foreground">{t('cached')}</p> : null}
          <Block title={t('opener')}>
            <p>{script.opener}</p>
          </Block>
          <Block title={t('observations')}>
            <ul className="list-disc space-y-1 pl-5">
              {script.observations.map((item) => (
                <li key={item.text}>{item.text}</li>
              ))}
            </ul>
          </Block>
          {script.previewMention ? (
            <Block title={t('preview')}>
              <p>{script.previewMention}</p>
            </Block>
          ) : null}
          <Block title={t('questions')}>
            <ul className="list-disc space-y-1 pl-5">
              {script.questions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          </Block>
          <Block title={t('objections')}>
            <dl className="space-y-2">
              {script.objections.map((item) => (
                <div key={item.objection}>
                  <dt className="font-medium">{item.objection}</dt>
                  <dd className="text-muted-foreground">{item.answer}</dd>
                </div>
              ))}
            </dl>
          </Block>
          <Block title={t('nextStep')}>
            <p>{script.nextStep}</p>
          </Block>
          <Block title={t('reminders')}>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {script.reminders.map((reminder) => (
                <li key={reminder}>{reminder}</li>
              ))}
            </ul>
          </Block>
        </div>
      )}
    </section>
  );
}

function Block({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-3">
      <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h4>
      {children}
    </div>
  );
}
