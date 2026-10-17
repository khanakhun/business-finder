'use client';

import type { CallOutcome } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { ExternalLinkIcon, MessageCircleIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import type { BusinessTabProps } from '@/features/business/tabs/registry.ts';
import { useCallWorkspace } from './api.ts';
import { OutcomeForm } from './outcome-form.tsx';
import { ScriptView } from './script-view.tsx';
import { BestTimeLine, ChannelDecision, DialButton, formatDuration, useDialTimer } from './shared.tsx';
import { WhatsAppComposer } from './whatsapp-composer.tsx';

/**
 * A business's Call tab (BF-057): the phone and WhatsApp decisions before any action (no call or WhatsApp action
 * when blocked or do-not-contact), the best time to call, one-tap call with a timer, the outcome form on return, the
 * grounded script, WhatsApp assist, and the history of manual contacts.
 */
export function CallTab({ business }: BusinessTabProps) {
  const t = useTranslations('assist');
  const labels = useTranslations('assist.outcomes');
  const channels = useTranslations('assist.channels');
  const format = useFormatter();
  const errorLabels = useErrorLabels();
  const workspace = useCallWorkspace(business.id);
  const [form, setForm] = React.useState<{ outcome?: CallOutcome; duration?: number } | null>(null);
  const [whatsApp, setWhatsApp] = React.useState(false);
  const timer = useDialTimer((seconds) => setForm({ duration: seconds }));

  if (workspace.isLoading) return <Skeleton className="h-60 w-full" />;
  if (!workspace.data)
    return (
      <ErrorState
        problem={toProblemLike(workspace.error, t('loadError'))}
        labels={errorLabels}
        onRetry={() => void workspace.refetch()}
      />
    );
  const data = workspace.data;
  const phoneOk = data.phone !== null && data.compliance.phone.decision !== 'blocked' && !data.doNotContact;
  const whatsAppOk = data.compliance.whatsapp.decision !== 'blocked' && !data.doNotContact;
  const target = {
    businessId: data.businessId,
    businessName: data.businessName,
    contactId: data.phone?.contactId ?? null,
  };
  const endCall = () => {
    const duration = timer.elapsed;
    timer.stop();
    setForm({ duration });
  };

  return (
    <div className="grid gap-6 text-sm lg:grid-cols-[22rem_1fr]">
      <aside className="space-y-4">
        <section className="space-y-3 rounded-lg border p-3">
          {data.doNotContact ? <p className="font-medium text-destructive">{t('doNotContact')}</p> : null}
          <ChannelDecision label={t('channels.phone')} decision={data.compliance.phone} />
          <BestTimeLine bestTime={data.bestTime} />
          {!data.phone ? (
            <p className="text-muted-foreground">{t('noPhone')}</p>
          ) : phoneOk ? (
            <div className="space-y-2">
              <DialButton e164={data.phone.e164} onDial={timer.start} />
              {timer.running ? (
                <Button variant="outline" className="min-h-11 w-full" onClick={endCall}>
                  {t('endCall', { duration: formatDuration(timer.elapsed) })}
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-muted-foreground">{t('phoneBlocked')}</p>
          )}
          {phoneOk ? (
            <Button variant="outline" className="min-h-11 w-full" onClick={() => setForm({})}>
              {t('logOutcome')}
            </Button>
          ) : null}
        </section>
        <section className="space-y-3 rounded-lg border p-3">
          <ChannelDecision label={t('channels.whatsapp')} decision={data.compliance.whatsapp} />
          {whatsAppOk && (data.whatsapp || data.phone) ? (
            <Button variant="outline" className="min-h-11 w-full" onClick={() => setWhatsApp(true)}>
              <MessageCircleIcon aria-hidden />
              {t('whatsapp.action')}
            </Button>
          ) : (
            <p className="text-muted-foreground">
              {whatsAppOk ? t('whatsapp.noNumber') : t('whatsapp.blocked')}
            </p>
          )}
        </section>
        {data.previewUrl ? (
          <Button asChild variant="link" className="px-0">
            <a href={data.previewUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon aria-hidden />
              {t('openPreview')}
            </a>
          </Button>
        ) : null}
        <section className="space-y-2">
          <h3 className="font-semibold">{t('history')}</h3>
          {data.history.length === 0 ? (
            <p className="text-muted-foreground">{t('noHistory')}</p>
          ) : (
            <ul className="space-y-2">
              {data.history.map((log) => (
                <li key={log.id} className="rounded-lg border p-2">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{channels(log.channel)}</Badge>
                    {log.outcome && labels.has(log.outcome as 'no_answer') ? (
                      <span className="font-medium">{labels(log.outcome as 'no_answer')}</span>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {format.dateTime(new Date(log.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                  </p>
                  <p className="mt-1 whitespace-pre-line text-muted-foreground">{log.summary}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
      <ScriptView businessId={data.businessId} idPrefix="call-tab" />
      <OutcomeForm
        target={target}
        open={form !== null}
        onOpenChange={(open) => (open ? undefined : setForm(null))}
        initialOutcome={form?.outcome}
        durationSec={form?.duration}
        onWhatsApp={() => setWhatsApp(true)}
      />
      <WhatsAppComposer
        businessId={data.businessId}
        businessName={data.businessName}
        open={whatsApp}
        onOpenChange={setWhatsApp}
      />
    </div>
  );
}
