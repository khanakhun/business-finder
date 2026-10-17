'use client';

import { ApiError } from '@bf/api-client';
import type { EmailDraft } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { ClipboardCopyIcon, SendIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { useSequenceActions } from '@/features/sequences/api.ts';
import { getToast } from '@/lib/toast.tsx';
import { closeComposer } from '../composer/store.ts';
import { useMessageActions } from '../outbound-api.ts';
import { ManualLogDialog } from './manual-log-dialog.tsx';

/** Seconds the undo toast stays (the server's undo window; OUTREACH_UNDO_WINDOW_SECONDS, default 10). */
const UNDO_SECONDS = 10;

/**
 * The composer's Send (BF-052): one click queues the saved draft (the server judges it first) and an undo toast
 * cancels it within the window. A manual-only recipient gets "Copy & log" instead: the person sends it from their
 * own mail and the contact is logged with its decision.
 */
export function SendButton({
  draft,
  decision,
  disabled,
  copyText,
  followUpSequenceId,
}: {
  readonly draft: EmailDraft;
  /** Today's compliance decision for the recipient (preview). */
  readonly decision: string | undefined;
  readonly disabled: boolean;
  readonly copyText: () => string;
  /** Enroll the business in this sequence once the email is queued (BF-053, "attach follow-ups"). */
  readonly followUpSequenceId?: string | null;
}) {
  const t = useTranslations('outbound.send');
  const actions = useMessageActions();
  const sequences = useSequenceActions();
  const [manual, setManual] = React.useState(false);
  // One key per saved version of the draft: a double click (or a retried request) sends once.
  const key = `send-${draft.id}-${draft.updatedAt}`.replace(/[^A-Za-z0-9_.:-]/g, '');
  const copyAndLog = async () => {
    const toast = await getToast();
    await navigator.clipboard.writeText(copyText());
    toast.success(t('copied'));
    setManual(true);
  };
  const send = async () => {
    const toast = await getToast();
    try {
      const message = await actions.send.mutateAsync({ body: { draftId: draft.id, sendMode: 'now' }, key });
      if (followUpSequenceId)
        await sequences.enroll
          .mutateAsync({ id: followUpSequenceId, body: { fromMessageId: message.id } })
          .then((result) =>
            result.enrolled.length > 0
              ? toast.success(t('followUpAttached'))
              : toast.info(t('followUpSkipped')),
          )
          .catch(() => toast.error(t('followUpFailed')));
      closeComposer();
      toast.success(t('queued', { seconds: UNDO_SECONDS }), {
        duration: UNDO_SECONDS * 1000,
        action: {
          label: t('undo'),
          onClick: () => {
            void actions.cancel.mutateAsync(message.id).then(
              () => toast.success(t('undone')),
              (error: unknown) => toast.error(toProblemLike(error, t('tooLate')).detail ?? t('tooLate')),
            );
          },
        },
      });
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      const refusal = error instanceof ApiError ? error.problem.refusal : undefined;
      if (refusal?.decision === 'manual_only') {
        toast.info(t('manualOnly'));
        await copyAndLog();
        return;
      }
      const reasons = refusal?.reasons.map((reason) => reason.message).join(' · ');
      toast.error(
        reasons ? `${problem.detail ?? problem.title} ${reasons}` : (problem.detail ?? problem.title),
      );
    }
  };
  return (
    <>
      {decision === 'manual_only' ? (
        <Button size="sm" disabled={disabled} onClick={() => void copyAndLog()}>
          <ClipboardCopyIcon aria-hidden />
          {t('copyAndLog')}
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={disabled || decision === 'blocked' || actions.send.isPending}
          onClick={() => void send()}
        >
          <SendIcon aria-hidden />
          {t('send')}
        </Button>
      )}
      <ManualLogDialog
        open={manual}
        onOpenChange={setManual}
        businessId={draft.businessId}
        contactId={draft.contactId}
        defaultSummary={t('manualSummary', { subject: draft.subject })}
      />
    </>
  );
}
