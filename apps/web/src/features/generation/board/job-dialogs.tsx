'use client';

import { Button } from '@bf/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { Label } from '@bf/ui/components/label';
import { Textarea } from '@bf/ui/components/textarea';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useQuality } from '../api.ts';

// Confirmations on the board (BF-046): cancelling a running job, and publishing a reviewed version anyway (a reason
// of 10–500 characters; refused, here as on the server, when the schema or facts gate did not pass).

export const MIN_REASON = 10;
export const MAX_REASON = 500;
/** Gates whose failure no person may override (BF-045 decision policy). */
const BLOCKING = new Set(['schema', 'facts']);

export function CancelJobDialog({
  name,
  open,
  onOpenChange,
  onConfirm,
  pending,
}: {
  readonly name: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
  readonly pending: boolean;
}) {
  const t = useTranslations('generation.board.cancelDialog');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', { name })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('keep')}
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={onConfirm}>
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AcceptJobDialog({
  jobId,
  name,
  open,
  onOpenChange,
  onConfirm,
  pending,
}: {
  readonly jobId: string;
  readonly name: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (reason: string) => void;
  readonly pending: boolean;
}) {
  const t = useTranslations('generation.board.acceptDialog');
  const quality = useQuality(jobId, open);
  const [reason, setReason] = React.useState('');
  const report = quality.data?.report ?? null;
  const failing = (report?.gates ?? []).filter((gate) => BLOCKING.has(gate.id) && gate.status !== 'pass');
  const blocked = quality.isSuccess && (!report || failing.length > 0);
  const valid = reason.trim().length >= MIN_REASON && reason.trim().length <= MAX_REASON;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', { name })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {report ? (
          <p className="text-sm">
            {t('score', { score: report.score })}{' '}
            <span className="text-muted-foreground">{t('issues', { count: report.issues.length })}</span>
          </p>
        ) : null}
        {blocked ? (
          <p role="alert" className="text-sm text-destructive">
            {report ? t('blocked', { gates: failing.map((gate) => gate.id).join(', ') }) : t('noReport')}
          </p>
        ) : (
          <div className="space-y-1">
            <Label htmlFor={`accept-reason-${jobId}`}>{t('reason')}</Label>
            <Textarea
              id={`accept-reason-${jobId}`}
              rows={3}
              maxLength={MAX_REASON}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              aria-describedby={`accept-reason-${jobId}-hint`}
            />
            <p id={`accept-reason-${jobId}-hint`} className="text-xs text-muted-foreground">
              {t('reasonHint', { min: MIN_REASON })}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
          <Button
            type="button"
            disabled={blocked || !valid || pending || !quality.isSuccess}
            onClick={() => onConfirm(reason.trim())}
          >
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
