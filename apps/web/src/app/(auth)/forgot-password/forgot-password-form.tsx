'use client';

import { Button } from '@bf/ui/components/button';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { AuthCard } from '@/components/auth/auth-card.tsx';
import { Field, FormError, useErrorMessage } from '@/components/auth/fields.tsx';
import { authClient, unwrap } from '@/lib/auth-client.ts';

export function ForgotPasswordForm() {
  const t = useTranslations('auth');
  const errorMessage = useErrorMessage();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [sentTo, setSentTo] = React.useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email'));
    setError(null);
    setPending(true);
    try {
      await unwrap(authClient().requestPasswordReset({ email }));
      // Same answer whether or not the account exists (no enumeration).
      setSentTo(email);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  const back = (
    <Link href="/sign-in" className="font-medium text-primary underline-offset-4 hover:underline">
      {t('forgot.back')}
    </Link>
  );
  if (sentTo) {
    return (
      <AuthCard title={t('forgot.sentTitle')} footer={back}>
        <p role="status">{t('forgot.sent', { email: sentTo })}</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t('forgot.title')} description={t('forgot.description')} footer={back}>
      <form className="grid gap-4" onSubmit={onSubmit}>
        <FormError message={error} />
        <Field label={t('email')} name="email" type="email" autoComplete="email" required autoFocus />
        <Button type="submit" disabled={pending}>
          {t('forgot.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
