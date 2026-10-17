'use client';

import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import type { BusinessTabProps } from '@/features/business/tabs/registry.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useEnrollments, useSequenceActions, useSequences } from './api.ts';

/** A business's sequences (BF-053): enroll it, follow its enrollment step by step, pause, resume or stop it. */
export function SequencesTab({ business }: BusinessTabProps) {
  const t = useTranslations('sequences.tab');
  const reasons = useTranslations('sequences.reasons');
  const format = useFormatter();
  const enrollments = useEnrollments(business.id);
  const sequences = useSequences();
  const actions = useSequenceActions();
  const canSend = usePermission('outreach:send');
  const [chosen, setChosen] = React.useState<string>('');
  const active = (sequences.data ?? []).filter((sequence) => sequence.status === 'active');
  const running = (enrollments.data ?? []).some((e) => e.status === 'active' || e.status === 'paused');
  const run = async (call: () => Promise<unknown>, done: string) => {
    const toast = await getToast();
    try {
      await call();
      toast.success(done);
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  const enroll = () =>
    run(async () => {
      const result = await actions.enroll.mutateAsync({
        id: chosen,
        body: { items: [{ businessId: business.id as never, contactId: null }] },
      });
      if (result.skipped[0]) throw new Error(result.skipped[0].reason);
    }, t('enrolled'));
  if (!enrollments.data) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="space-y-4 text-sm">
      {canSend && !running ? (
        <div className="flex flex-wrap items-end gap-2">
          <Select value={chosen} onValueChange={setChosen}>
            <SelectTrigger aria-label={t('pick')} className="w-72">
              <SelectValue placeholder={t('pick')} />
            </SelectTrigger>
            <SelectContent>
              {active.map((sequence) => (
                <SelectItem key={sequence.id} value={sequence.id}>
                  {sequence.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" disabled={!chosen || actions.enroll.isPending} onClick={() => void enroll()}>
            {t('enroll')}
          </Button>
        </div>
      ) : null}
      {enrollments.data.length === 0 ? (
        <p className="text-muted-foreground">{t('none')}</p>
      ) : (
        <ul className="space-y-3">
          {enrollments.data.map((enrollment) => (
            <li key={enrollment.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{enrollment.sequenceName}</span>
                <Badge variant={enrollment.status === 'active' ? 'secondary' : 'outline'}>
                  {t(`status.${enrollment.status}`)}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {t('progress', {
                    step: Math.min(enrollment.currentStepIndex + 1, enrollment.stepCount),
                    total: enrollment.stepCount,
                  })}
                  {enrollment.nextRunAt
                    ? ` · ${t('next', { when: format.dateTime(new Date(enrollment.nextRunAt), { dateStyle: 'medium', timeStyle: 'short' }) })}`
                    : ''}
                </span>
                {canSend ? (
                  <div className="ml-auto flex gap-1">
                    {enrollment.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void run(() => actions.pause.mutateAsync(enrollment.id), t('paused'))}
                      >
                        {t('pause')}
                      </Button>
                    ) : null}
                    {enrollment.status === 'paused' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void run(() => actions.resume.mutateAsync(enrollment.id), t('resumed'))
                        }
                      >
                        {t('resume')}
                      </Button>
                    ) : null}
                    {enrollment.status === 'active' || enrollment.status === 'paused' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void run(() => actions.stop.mutateAsync(enrollment.id), t('stopped'))}
                      >
                        {t('stop')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {enrollment.stopReason ? (
                <p className="text-xs text-muted-foreground">
                  {t('stopReason', { reason: reasons(enrollment.stopReason as 'replied') })}
                </p>
              ) : null}
              {enrollment.pauseReason ? (
                <p className="text-xs text-muted-foreground">
                  {t('pauseReason', { reason: enrollment.pauseReason })}
                </p>
              ) : null}
              <ol className="mt-2 space-y-1 border-l pl-3 text-xs">
                {enrollment.events.map((event) => (
                  <li key={`${event.at}-${event.kind}-${event.stepId ?? ''}`}>
                    <span className="text-muted-foreground">
                      {format.dateTime(new Date(event.at), { dateStyle: 'short', timeStyle: 'short' })}
                    </span>{' '}
                    {t(`events.${event.kind}`)}
                    {event.stepId ? ` · ${event.stepId}` : ''}
                    {event.detail ? ` · ${event.detail}` : ''}
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
