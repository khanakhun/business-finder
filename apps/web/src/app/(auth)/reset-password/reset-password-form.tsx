'use client';

import { Button } from '@bf/ui/components/button';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { AuthCard } from '@/components/auth/auth-card.tsx';
import { FormError, PasswordField, useErrorMessage } from '@/components/auth/fields.tsx';
import { authClient, unwrap } from '@/lib/auth-client.ts';

export function ResetPasswordForm({
  token,
  minPasswordLength,
}: {
  readonly token: string | null;
  readonly minPasswordLength: number;
}) {
  const t = useTranslations('auth');
  const errorMessage = useErrorMessage();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [done, setDone] = React.useState(false);

  const signIn = (
    <Link href="/sign-in" className="font-medium text-primary underline-offset-4 hover:underline">
      {t('signIn.submit')}
    </Link>
  );
  if (!token) {
    return (
      <AuthCard title={t('reset.title')} footer={signIn}>
        <p>{t('reset.missingToken')}</p>
      </AuthCard>
    );
  }
  if (done) {
    return (
      <AuthCard title={t('reset.title')} footer={signIn}>
        <p role="status">{t('reset.done')}</p>
      </AuthCard>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const newPassword = String(new FormData(event.currentTarget).get('password'));
    setError(null);
    setPending(true);
    try {
      await unwrap(authClient().resetPassword({ newPassword, token: token ?? '' }));
      setDone(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthCard title={t('reset.title')}>
      <form className="grid gap-4" onSubmit={onSubmit}>
        <FormError message={error} />
        <PasswordField
          label={t('newPassword')}
          name="password"
          autoComplete="new-password"
          required
          minLength={minPasswordLength}
          hint={t('passwordHint', { min: minPasswordLength })}
          autoFocus
        />
        <Button type="submit" disabled={pending}>
          {t('reset.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
