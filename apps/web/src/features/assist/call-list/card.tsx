'use client';

import type { CallList, CallOutcome } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { ChevronDownIcon, ChevronUpIcon, ExternalLinkIcon, MessageCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { OutcomeForm } from '../outcome-form.tsx';
import { ScriptView } from '../script-view.tsx';
import { BestTimeLine, DialButton, formatDuration, useDialTimer } from '../shared.tsx';
import { WhatsAppComposer } from '../whatsapp-composer.tsx';

type Item = CallList['tasks'][number];

const QUICK: readonly CallOutcome[] = ['no_answer', 'voicemail', 'interested', 'call_back'];

/** One business to call (BF-057): tier, task, best time, one-tap call, the script, WhatsApp, quick outcomes. */
export function CallCard({ item }: { readonly item: Item }) {
  const t = useTranslations('assist');
  const labels = useTranslations('assist.outcomes');
  const format = useFormatter();
  const [script, setScript] = React.useState(false);
  const [whatsApp, setWhatsApp] = React.useState(false);
  const [form, setForm] = React.useState<{ outcome?: CallOutcome; duration?: number } | null>(null);
  const timer = useDialTimer((seconds) => setForm({ duration: seconds }));
  const idPrefix = `card-${item.businessId}`;
  return (
    <article className="space-y-3 rounded-xl border p-4" aria-labelledby={`${idPrefix}-name`}>
      <header className="flex flex-wrap items-start gap-2">
        <h2 id={`${idPrefix}-name`} className="mr-auto text-base font-semibold">
          <Link href={`/businesses/${item.businessId}?tab=call`} className="hover:underline">
            {item.businessName}
          </Link>
        </h2>
        {item.tier ? <Badge variant="secondary">{t('list.tier', { tier: item.tier })}</Badge> : null}
      </header>
      {item.taskTitle ? (
        <p className="text-sm">
          {item.taskTitle}
          {item.dueAt ? (
            <span className="text-muted-foreground">
              {' · '}
              {format.dateTime(new Date(item.dueAt), { hour: '2-digit', minute: '2-digit' })}
            </span>
          ) : null}
        </p>
      ) : null}
      <BestTimeLine bestTime={item.bestTime} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <DialButton e164={item.phone} onDial={timer.start} />
        {timer.running ? (
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => {
              const duration = timer.elapsed;
              timer.stop();
              setForm({ duration });
            }}
          >
            {t('endCall', { duration: formatDuration(timer.elapsed) })}
          </Button>
        ) : (
          <Button variant="outline" className="min-h-11" onClick={() => setWhatsApp(true)}>
            <MessageCircleIcon aria-hidden />
            {t('whatsapp.action')}
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {QUICK.map((outcome) => (
          <Button
            key={outcome}
            variant="secondary"
            className="min-h-11 whitespace-normal"
            onClick={() => setForm({ outcome })}
          >
            {labels(outcome)}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          className="min-h-11"
          aria-expanded={script}
          aria-controls={`${idPrefix}-script-panel`}
          onClick={() => setScript((shown) => !shown)}
        >
          {script ? <ChevronUpIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
          {script ? t('list.hideScript') : t('list.showScript')}
        </Button>
        {item.previewUrl ? (
          <Button asChild variant="ghost" className="min-h-11">
            <a href={item.previewUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon aria-hidden />
              {t('openPreview')}
            </a>
          </Button>
        ) : null}
        <Button variant="ghost" className="min-h-11" onClick={() => setForm({})}>
          {t('logOutcome')}
        </Button>
      </div>
      {script ? (
        <div id={`${idPrefix}-script-panel`}>
          <ScriptView businessId={item.businessId} idPrefix={idPrefix} />
        </div>
      ) : null}
      <OutcomeForm
        target={{ businessId: item.businessId, businessName: item.businessName, contactId: null }}
        open={form !== null}
        onOpenChange={(open) => (open ? undefined : setForm(null))}
        initialOutcome={form?.outcome}
        durationSec={form?.duration}
        onWhatsApp={() => setWhatsApp(true)}
      />
      {whatsApp ? (
        <WhatsAppComposer
          businessId={item.businessId}
          businessName={item.businessName}
          open={whatsApp}
          onOpenChange={setWhatsApp}
        />
      ) : null}
    </article>
  );
}
