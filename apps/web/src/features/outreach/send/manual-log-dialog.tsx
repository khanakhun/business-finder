'use client';

import { MANUAL_CONTACT_CHANNELS, type ManualContactChannel } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Textarea } from '@bf/ui/components/textarea';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { getToast } from '@/lib/toast.tsx';
import { useMessageActions } from '../outbound-api.ts';

/**
 * Logs a contact made by hand (BF-052): "Copy & send manually" for a manual-only recipient, a call, a WhatsApp
 * message, a letter, a visit. The server judges it (stage `manual_log`) and refuses a suppressed business.
 */
export function ManualLogDialog({
  open,
  onOpenChange,
  businessId,
  contactId,
  defaultChannel = 'email',
  defaultSummary = '',
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly businessId: string;
  readonly contactId?: string | null | undefined;
  readonly defaultChannel?: ManualContactChannel;
  readonly defaultSummary?: string;
}) {
  const t = useTranslations('outbound.manual');
  const actions = useMessageActions();
  const [channel, setChannel] = React.useState<ManualContactChannel>(defaultChannel);
  const [summary, setSummary] = React.useState(defaultSummary);
  const [outcome, setOutcome] = React.useState('');
  React.useEffect(() => {
    if (open) {
      setChannel(defaultChannel);
      setSummary(defaultSummary);
      setOutcome('');
    }
  }, [open, defaultChannel, defaultSummary]);
  const submit = async () => {
    const toast = await getToast();
    try {
      await actions.manualLog.mutateAsync({
        businessId: businessId as never,
        contactId: contactId ?? null,
        channel,
        summary,
        ...(outcome.trim() ? { outcome: outcome.trim() } : {}),
      });
      toast.success(t('logged'));
      onOpenChange(false);
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="ml-channel">{t('channel')}</Label>
            <Select value={channel} onValueChange={(value) => setChannel(value as ManualContactChannel)}>
              <SelectTrigger id="ml-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_CONTACT_CHANNELS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`channels.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ml-summary">{t('summary')}</Label>
            <Textarea
              id="ml-summary"
              rows={4}
              maxLength={2000}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ml-outcome">{t('outcome')}</Label>
            <Input
              id="ml-outcome"
              maxLength={200}
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button disabled={!summary.trim() || actions.manualLog.isPending} onClick={() => void submit()}>
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
