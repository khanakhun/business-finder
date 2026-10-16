'use client';

import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import { Label } from '@bf/ui/components/label';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { AuthCard } from '@/components/auth/auth-card.tsx';
import { Field, FormError, useErrorMessage } from '@/components/auth/fields.tsx';
import { authClient, unwrap } from '@/lib/auth-client.ts';

/** Second step of sign-in when 2FA is on: a TOTP code, or one of the backup codes. */
export function TwoFactorForm({ next }: { readonly next: string }) {
  const t = useTranslations('auth');
  const errorMessage = useErrorMessage();
  const [mode, setMode] = React.useState<'totp' | 'backup'>('totp');
  const [trust, setTrust] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code')).replaceAll(/\s/g, '');
    setError(null);
    setPending(true);
    try {
      const client = authClient().twoFactor;
      await unwrap(
        mode === 'totp'
          ? client.verifyTotp({ code, trustDevice: trust })
          : client.verifyBackupCode({ code, trustDevice: trust }),
      );
      window.location.assign(next);
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <AuthCard
      title={t('twoFactor.title')}
      description={mode === 'totp' ? t('twoFactor.description') : undefined}
    >
      <form className="grid gap-4" onSubmit={onSubmit}>
        <FormError message={error} />
        {mode === 'totp' ? (
          <Field
            key="totp"
            label={t('twoFactor.code')}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            required
            autoFocus
          />
        ) : (
          <Field
            key="backup"
            label={t('twoFactor.backupCode')}
            name="code"
            autoComplete="off"
            required
            autoFocus
          />
        )}
        <div className="flex items-center gap-2">
          <Checkbox id="trust" checked={trust} onCheckedChange={(value) => setTrust(value === true)} />
          <Label htmlFor="trust" className="font-normal">
            {t('twoFactor.trust')}
          </Label>
        </div>
        <Button type="submit" disabled={pending}>
          {t('twoFactor.submit')}
        </Button>
        <Button type="button" variant="link" onClick={() => setMode(mode === 'totp' ? 'backup' : 'totp')}>
          {mode === 'totp' ? t('twoFactor.useBackup') : t('twoFactor.useTotp')}
        </Button>
      </form>
    </AuthCard>
  );
}
