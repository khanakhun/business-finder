'use client';

import { CALL_OUTCOMES, type CallOutcome } from '@bf/contracts';
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
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Textarea } from '@bf/ui/components/textarea';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { openComposer } from '@/features/outreach/composer/store.ts';
import { useSession } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useOutcomeSettled } from './api.ts';
import { newOutcomeKey, submitOutcome } from './call-list/offline-queue.ts';
import { formatDuration } from './shared.tsx';

// The outcome form (BF-057): what happened on the call. It becomes a manual contact log (with its compliance decision)
// whose effects the API applies — pipeline, tasks, suppression; "info by email" opens the composer with the call as
// context, "info by WhatsApp" the WhatsApp composer. Offline, the outcome is queued and sent once back online.

// DECISION(BF-057): the composer gets the call as an instruction to the AI draft (it is model input, kept in English).
const AFTER_CALL =
  'We spoke on the phone today and they asked for the information by email: say so briefly and send what was promised.';

export interface OutcomeTarget {
  readonly businessId: string;
  readonly businessName: string;
  readonly contactId: string | null;
}

export function OutcomeForm({
  target,
  open,
  onOpenChange,
  initialOutcome,
  durationSec,
  onWhatsApp,
}: {
  readonly target: OutcomeTarget;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialOutcome?: CallOutcome | undefined;
  readonly durationSec?: number | undefined;
  readonly onWhatsApp?: () => void;
}) {
  const t = useTranslations('assist.outcome');
  const labels = useTranslations('assist.outcomes');
  const { user } = useSession();
  const settled = useOutcomeSettled();
  const [outcome, setOutcome] = React.useState<CallOutcome | null>(initialOutcome ?? null);
  const [notes, setNotes] = React.useState('');
  const [minutes, setMinutes] = React.useState(durationSec ? String(Math.round(durationSec / 60)) : '');
  const [callbackAt, setCallbackAt] = React.useState('');
  const [doNotContact, setDoNotContact] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // One key per form: a double tap or a re-submission from the queue logs the outcome once.
  const [key, setKey] = React.useState(newOutcomeKey);

  React.useEffect(() => {
    if (!open) return;
    setOutcome(initialOutcome ?? null);
    setMinutes(durationSec ? String(Math.max(1, Math.round(durationSec / 60))) : '');
    setNotes('');
    setCallbackAt('');
    setDoNotContact(false);
    setKey(newOutcomeKey());
  }, [open, initialOutcome, durationSec]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!outcome) return;
    setBusy(true);
    const toast = await getToast();
    try {
      const result = await submitOutcome(user.id, target.businessId, {
        channel: 'phone',
        outcome,
        notes: notes.trim(),
        ...(minutes ? { durationSec: Math.min(4 * 3_600, Math.round(Number(minutes) * 60)) } : {}),
        ...(outcome === 'call_back' && callbackAt ? { callbackAt: new Date(callbackAt).toISOString() } : {}),
        contactId: target.contactId,
        doNotContact: outcome === 'do_not_call' && doNotContact,
        idempotencyKey: key,
      });
      onOpenChange(false);
      if (!result) {
        toast.info(t('queued'));
        return;
      }
      toast.success(t('logged'));
      settled(target.businessId);
      if (result.next === 'compose')
        openComposer({
          businessId: target.businessId,
          businessName: target.businessName,
          instructions: AFTER_CALL,
        });
      if (result.next === 'whatsapp') onWhatsApp?.();
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title', { business: target.businessName })}</DialogTitle>
          <DialogDescription>
            {durationSec ? t('duration', { duration: formatDuration(durationSec) }) : t('hint')}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4 text-sm" onSubmit={(event) => void submit(event)}>
          <fieldset>
            <legend className="mb-2 font-medium">{t('what')}</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {CALL_OUTCOMES.map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant={outcome === value ? 'default' : 'outline'}
                  aria-pressed={outcome === value}
                  className="min-h-11 justify-start whitespace-normal text-left"
                  onClick={() => setOutcome(value)}
                >
                  {labels(value)}
                </Button>
              ))}
            </div>
          </fieldset>
          {outcome === 'call_back' ? (
            <div className="space-y-1">
              <Label htmlFor="outcome-callback">{t('callbackAt')}</Label>
              <Input
                id="outcome-callback"
                type="datetime-local"
                value={callbackAt}
                onChange={(event) => setCallbackAt(event.target.value)}
              />
            </div>
          ) : null}
          {outcome === 'do_not_call' ? (
            <div className="flex items-start gap-2">
              <Checkbox
                id="outcome-dnc"
                checked={doNotContact}
                onCheckedChange={(checked) => setDoNotContact(checked === true)}
              />
              <Label htmlFor="outcome-dnc" className="font-normal">
                {t('doNotContact')}
              </Label>
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="outcome-minutes">{t('minutes')}</Label>
            <Input
              id="outcome-minutes"
              type="number"
              inputMode="numeric"
              min={0}
              max={240}
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              className="w-28"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="outcome-notes">{t('notes')}</Label>
            <Textarea
              id="outcome-notes"
              rows={3}
              maxLength={2_000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!outcome || busy} className="min-h-11">
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
