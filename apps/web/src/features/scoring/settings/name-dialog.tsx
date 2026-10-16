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
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { FormError, useErrorMessage } from '@/components/auth/fields.tsx';

/** Names a profile (duplicate, rename); failures show inline and keep the dialog open. */
export function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  initial,
  submitLabel,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly initial: string;
  readonly submitLabel: string;
  readonly onSubmit: (name: string) => Promise<void>;
}) {
  const t = useTranslations('scoringSettings');
  const errorMessage = useErrorMessage();
  const [name, setName] = React.useState(initial);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setName(initial);
      setError(null);
    }
  }, [open, initial]);
  const trimmed = name.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!trimmed) return;
            setPending(true);
            setError(null);
            try {
              await onSubmit(trimmed);
              onOpenChange(false);
            } catch (caught) {
              setError(errorMessage(caught));
            } finally {
              setPending(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="profile-name">{t('name')}</Label>
            <Input
              id="profile-name"
              value={name}
              maxLength={80}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={pending || !trimmed}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
