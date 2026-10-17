'use client';

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
import { Label } from '@bf/ui/components/label';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Textarea } from '@bf/ui/components/textarea';
import { MessageCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { useSession } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useCallWorkspace, useOutcomeSettled, useWhatsAppDraft } from './api.ts';
import { newOutcomeKey, submitOutcome } from './call-list/offline-queue.ts';
import { ChannelDecision, waLink } from './shared.tsx';

// WhatsApp assist (BF-057): a short personal message drafted from the facts (the preview link and an opt-out line
// added by the API), editable, opened in WhatsApp with wa.me; the person sends it themselves and confirms, which logs
// it. WhatsApp replies are not read by the app: log them as outcomes.

export function WhatsAppComposer({
  businessId,
  businessName,
  open,
  onOpenChange,
}: {
  readonly businessId: string;
  readonly businessName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('assist.whatsapp');
  const { user } = useSession();
  const workspace = useCallWorkspace(businessId);
  const draft = useWhatsAppDraft(businessId);
  const settled = useOutcomeSettled();
  const [usePhone, setUsePhone] = React.useState(false);
  const [text, setText] = React.useState('');
  const [e164, setE164] = React.useState<string | null>(null);
  const [opened, setOpened] = React.useState(false);
  const [key, setKey] = React.useState(newOutcomeKey);

  React.useEffect(() => {
    if (!open) return;
    setText('');
    setE164(null);
    setOpened(false);
    setKey(newOutcomeKey());
  }, [open]);

  const data = workspace.data;
  const blocked = data?.compliance.whatsapp.decision === 'blocked' || data?.doNotContact === true;
  const write = async () => {
    try {
      const result = await draft.mutateAsync({ usePhone });
      setText(result.text);
      setE164(result.e164);
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      (await getToast()).error(problem.detail ?? problem.title);
    }
  };
  const confirm = async () => {
    const toast = await getToast();
    try {
      const result = await submitOutcome(user.id, businessId, {
        channel: 'whatsapp',
        notes: text.slice(0, 2_000),
        contactId: data?.whatsapp?.contactId ?? data?.phone?.contactId ?? null,
        doNotContact: false,
        idempotencyKey: key,
      });
      toast.success(result ? t('logged') : t('queued'));
      if (result) settled(businessId);
      onOpenChange(false);
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title', { business: businessName })}</DialogTitle>
          <DialogDescription>{t('hint')}</DialogDescription>
        </DialogHeader>
        {!data ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <div className="space-y-4 text-sm">
            <ChannelDecision label={t('channel')} decision={data.compliance.whatsapp} />
            {blocked ? (
              <p className="rounded-lg border border-destructive/40 p-3">
                {data.doNotContact ? t('doNotContact') : t('blocked')}
              </p>
            ) : (
              <>
                {data.whatsapp ? (
                  <p>{t('number', { number: data.whatsapp.e164 })}</p>
                ) : data.phone ? (
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="wa-use-phone"
                      checked={usePhone}
                      onCheckedChange={(checked) => setUsePhone(checked === true)}
                    />
                    <Label htmlFor="wa-use-phone" className="font-normal">
                      {t('usePhone', { number: data.phone.e164 })}
                    </Label>
                  </div>
                ) : (
                  <p className="text-muted-foreground">{t('noNumber')}</p>
                )}
                {text ? (
                  <div className="space-y-1">
                    <Label htmlFor="wa-text">{t('message')}</Label>
                    <Textarea
                      id="wa-text"
                      rows={7}
                      maxLength={600}
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">{t('count', { count: text.length })}</p>
                  </div>
                ) : (
                  <Button
                    onClick={() => void write()}
                    disabled={draft.isPending || (!data.whatsapp && !(data.phone && usePhone))}
                    className="min-h-11"
                  >
                    {draft.isPending ? t('writing') : t('write')}
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">{t('replies')}</p>
              </>
            )}
          </div>
        )}
        {text && e164 && !blocked ? (
          <DialogFooter className="gap-2">
            <Button asChild variant={opened ? 'outline' : 'default'} className="min-h-11">
              <a
                href={waLink(e164, text)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpened(true)}
              >
                <MessageCircleIcon aria-hidden />
                {t('open')}
              </a>
            </Button>
            <Button onClick={() => void confirm()} disabled={!opened} className="min-h-11">
              {t('sent')}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
