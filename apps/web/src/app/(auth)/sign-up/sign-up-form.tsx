'use client';

import type { IdentityConfig } from '@bf/contracts';
import { Alert, AlertDescription, AlertTitle } from '@bf/ui/components/alert';
import { Button } from '@bf/ui/components/button';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import { AuthCard } from '@/components/auth/auth-card.tsx';
import { Field, FormError, PasswordField, useErrorMessage } from '@/components/auth/fields.tsx';
import { authClient, unwrap } from '@/lib/auth-client.ts';

export function SignUpForm({
  next,
  mode,
  showForm,
  minPasswordLength,
}: {
  readonly next: string;
  readonly mode: IdentityConfig['signupMode'];
  readonly showForm: boolean;
  readonly minPasswordLength: number;
}) {
  const t = useTranslations('auth');
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [sentTo, setSentTo] = React.useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email'));
    setError(null);
    setPending(true);
    try {
      await unwrap(
        authClient().signUp.email({
          email,
          password: String(form.get('password')),
          name: String(form.get('name')),
          locale,
          callbackURL: new URL(`/verify-email?next=${encodeURIComponent(next)}`, window.location.origin).href,
        }),
      );
      // Same message whether or not an account was created: the response must not reveal who may register.
      setSentTo(email);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  const signInHref = `/sign-in${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`;
  const footer = (
    <>
      {t('signUp.haveAccount')}{' '}
      <Link href={signInHref} className="font-medium text-primary underline-offset-4 hover:underline">
        {t('signIn.submit')}
      </Link>
    </>
  );

  if (sentTo) {
    return (
      <AuthCard title={t('signUp.checkEmailTitle')} footer={footer}>
        <p role="status">{t('signUp.checkEmail', { email: sentTo })}</p>
      </AuthCard>
    );
  }
  if (!showForm) {
    return (
      <AuthCard title={t('signUp.title')} footer={footer}>
        <p>{t('signUp.inviteOnly')}</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t('signUp.title')} description={t('signUp.description')} footer={footer}>
      {mode === 'allowlist' ? (
        <Alert>
          <AlertTitle>{t('signUp.title')}</AlertTitle>
          <AlertDescription>{t('signUp.allowlist')}</AlertDescription>
        </Alert>
      ) : null}
      <form className="grid gap-4" onSubmit={onSubmit}>
        <FormError message={error} />
        <Field label={t('name')} name="name" autoComplete="name" required autoFocus />
        <Field label={t('email')} name="email" type="email" autoComplete="email" required />
        <PasswordField
          label={t('password')}
          name="password"
          autoComplete="new-password"
          required
          minLength={minPasswordLength}
          hint={t('passwordHint', { min: minPasswordLength })}
        />
        <Button type="submit" disabled={pending}>
          {t('signUp.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
