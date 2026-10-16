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
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { FormError, useErrorMessage } from '@/components/auth/fields.tsx';

/** "Are you sure?" before an action (destructive by default: the confirm button says so). Failures show inline. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  variant = 'destructive',
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => Promise<void>;
  readonly variant?: 'destructive' | 'default';
}) {
  const t = useTranslations('members');
  const errorMessage = useErrorMessage();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // A dialog kept mounted opens without the last attempt's error.
  React.useEffect(() => {
    if (open) setError(null);
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <FormError message={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            variant={variant}
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch (caught) {
                // Stays open with the reason (e.g. the last owner cannot be removed).
                setError(errorMessage(caught));
              } finally {
                setPending(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
