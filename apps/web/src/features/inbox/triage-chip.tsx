'use client';

import { type InboundMessage, TRIAGE_CLASSES, type TriageClass } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { useTranslations } from 'next-intl';
import { toProblemLike } from '@/components/states/problem.ts';
import { getToast } from '@/lib/toast.tsx';
import { useInboxActions } from './api.ts';

/** A reply's triage (BF-054): class, confidence, summary and entities; the class can be corrected (feedback). */
export function TriageChip({ message }: { readonly message: InboundMessage }) {
  const t = useTranslations('inbox.triage');
  const classes = useTranslations('inbox.classes');
  const actions = useInboxActions();
  const triage = message.triage;
  const current = message.correctedClass ?? triage?.class ?? null;
  const correct = async (value: TriageClass) => {
    const toast = await getToast();
    try {
      await actions.correct.mutateAsync({ id: message.id, triageClass: value });
      toast.success(t('corrected'));
    } catch (error) {
      toast.error(toProblemLike(error, t('failed')).title);
    }
  };
  if (message.kind !== 'human') return <Badge variant="outline">{t(`kinds.${message.kind}`)}</Badge>;
  const entities = triage?.entities;
  const facts = [
    entities?.phone ? t('phone', { value: entities.phone }) : null,
    entities?.preferredTime ? t('preferredTime', { value: entities.preferredTime }) : null,
    entities?.followUpOn ? t('followUpOn', { value: entities.followUpOn }) : null,
    entities?.referral?.name || entities?.referral?.email
      ? t('referral', {
          value: [entities.referral.name, entities.referral.email].filter(Boolean).join(' · '),
        })
      : null,
    entities?.priceQuestion ? t('priceQuestion') : null,
    entities?.meetingRequest ? t('meetingRequest') : null,
  ].filter((value): value is string => value !== null);
  return (
    <div className="space-y-1 rounded-md border bg-muted/40 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {current ? <Badge>{classes(current)}</Badge> : <Badge variant="outline">{t('pending')}</Badge>}
        {triage ? (
          <span className="text-xs text-muted-foreground">
            {t('confidence', { value: Math.round(triage.confidence * 100) })}
          </span>
        ) : null}
        {message.triageStatus === 'needs_human' ? <Badge variant="outline">{t('needsHuman')}</Badge> : null}
        {triage?.injectionSuspected ? <Badge variant="destructive">{t('injection')}</Badge> : null}
        {message.correctedClass ? <Badge variant="secondary">{t('correctedBadge')}</Badge> : null}
        <div className="ml-auto w-44">
          <Select value={current ?? undefined} onValueChange={(value) => void correct(value as TriageClass)}>
            <SelectTrigger aria-label={t('correct')} className="h-8">
              <SelectValue placeholder={t('correct')} />
            </SelectTrigger>
            <SelectContent>
              {TRIAGE_CLASSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {classes(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {triage?.summary ? <p>{triage.summary}</p> : null}
      {facts.length > 0 ? <p className="text-xs text-muted-foreground">{facts.join(' · ')}</p> : null}
      {triage?.suggestedNextAction ? (
        <p className="text-xs">{t('next', { value: triage.suggestedNextAction })}</p>
      ) : null}
      {message.unsubscribeDetected ? <p className="text-xs text-destructive">{t('unsubscribed')}</p> : null}
    </div>
  );
}
