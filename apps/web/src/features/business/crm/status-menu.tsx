'use client';

import type { CrmState, PipelineStatus, PipelineTransition } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@bf/ui/components/dropdown-menu';
import { Label } from '@bf/ui/components/label';
import { Textarea } from '@bf/ui/components/textarea';
import { cn } from '@bf/ui/lib/utils';
import { ChevronDownIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { apiClient } from '@/lib/api.ts';
import { useBusinessMutation } from '../api.ts';

/** The one colour cue per status: done (kelp), dropped (muted), everything in motion (lagoon). */
export function StatusDot({
  status,
  className,
}: {
  readonly status: PipelineStatus;
  readonly className?: string;
}) {
  const tone =
    status === 'won'
      ? 'bg-kelp'
      : status === 'lost' || status === 'disqualified'
        ? 'bg-muted-foreground/50'
        : status === 'new'
          ? 'border border-muted-foreground/60 bg-transparent'
          : 'bg-lagoon';
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', tone, className)} />;
}

/** Asks why a business is lost or disqualified (or why it must not be contacted). */
export function ReasonDialog({
  open,
  title,
  description,
  confirm,
  pending,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirm: string;
  readonly pending: boolean;
  readonly onConfirm: (reason: string) => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('business.reason');
  const [reason, setReason] = React.useState('');
  const id = React.useId();
  React.useEffect(() => {
    if (open) setReason('');
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim()) onConfirm(reason.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={id}>{t('label')}</Label>
            <Textarea
              id={id}
              value={reason}
              maxLength={500}
              rows={3}
              required
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!reason.trim() || pending}>
              {confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Moves a business through the pipeline: offers exactly the moves the API allows from its current status (never a
 * table of our own), and asks for a reason where one is required. The kanban uses it as its keyboard alternative.
 */
export function useStatusChange(businessId: string) {
  const t = useTranslations('business.status');
  const status = useTranslations('search.status');
  const [asking, setAsking] = React.useState<PipelineStatus | null>(null);
  const mutation = useBusinessMutation(
    businessId,
    async ({ to, reason }: { to: PipelineStatus; reason?: string }) =>
      (
        await apiClient().POST('/v1/businesses/{id}/status', {
          params: { path: { id: businessId } },
          body: { status: to, ...(reason ? { reason } : {}) },
        })
      ).data as CrmState,
    { success: (_result, { to }) => t('moved', { status: status(to) }) },
  );
  const move = (transition: PipelineTransition) => {
    if (transition.requiresReason) setAsking(transition.to);
    else mutation.mutate({ to: transition.to });
  };
  const dialog = (
    <ReasonDialog
      open={asking !== null}
      title={asking ? t('reasonTitle', { status: status(asking) }) : ''}
      description={t('reasonDescription')}
      confirm={asking ? t('moveTo', { status: status(asking) }) : ''}
      pending={mutation.isPending}
      onCancel={() => setAsking(null)}
      onConfirm={(reason) => {
        if (asking) mutation.mutate({ to: asking, reason }, { onSettled: () => setAsking(null) });
      }}
    />
  );
  return { move, mutation, dialog };
}

export function StatusMenu({
  businessId,
  businessName,
  current,
  transitions,
  disabled = false,
  size = 'default',
}: {
  readonly businessId: string;
  readonly businessName: string;
  readonly current: PipelineStatus;
  readonly transitions: readonly PipelineTransition[];
  readonly disabled?: boolean;
  readonly size?: 'default' | 'sm';
}) {
  const t = useTranslations('business.status');
  const status = useTranslations('search.status');
  const { move, mutation, dialog } = useStatusChange(businessId);
  const locked = disabled || transitions.length === 0;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={locked || mutation.isPending}>
          <Button
            type="button"
            variant="outline"
            size={size}
            aria-label={t('change', { name: businessName, status: status(current) })}
            className="gap-2"
          >
            <StatusDot status={current} />
            {status(current)}
            {locked ? null : <ChevronDownIcon aria-hidden className="size-4 opacity-60" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t('moveLabel')}</DropdownMenuLabel>
          {transitions.map((transition) => (
            <DropdownMenuItem key={transition.to} onSelect={() => move(transition)}>
              <StatusDot status={transition.to} />
              {status(transition.to)}
              {transition.requiresReason ? (
                <span className="ml-auto text-xs text-muted-foreground">{t('needsReason')}</span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}
