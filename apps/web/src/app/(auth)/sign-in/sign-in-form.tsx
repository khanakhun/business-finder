'use client';

import { Button } from '@bf/ui/components/button';
import { Separator } from '@bf/ui/components/separator';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { AuthCard } from '@/components/auth/auth-card.tsx';
import { Field, FormError, PasswordField, useErrorMessage } from '@/components/auth/fields.tsx';
import { authClient, unwrap } from '@/lib/auth-client.ts';

export function SignInForm({
  next,
  googleEnabled,
  signupOpen,
}: {
  readonly next: string;
  readonly googleEnabled: boolean;
  readonly signupOpen: boolean;
}) {
  const t = useTranslations('auth');
  const errorMessage = useErrorMessage();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setPending(true);
    try {
      const result = await unwrap(
        authClient().signIn.email({
          email: String(form.get('email')),
          password: String(form.get('password')),
        }),
      );
      // With 2FA on, the client plugin redirects to /two-factor itself.
      if (result && 'twoFactorRedirect' in result && result.twoFactorRedirect) return;
      window.location.assign(next);
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  const signUpHref = `/sign-up${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`;
  return (
    <AuthCard
      title={t('signIn.title')}
      description={t('signIn.description')}
      footer={
        signupOpen ? (
          <>
            {t('signIn.noAccount')}{' '}
            <Link href={signUpHref} className="font-medium text-primary underline-offset-4 hover:underline">
              {t('signIn.createOne')}
            </Link>
          </>
        ) : undefined
      }
    >
      <form className="grid gap-4" onSubmit={onSubmit} noValidate={false}>
        <FormError message={error} />
        <Field label={t('email')} name="email" type="email" autoComplete="email" required autoFocus />
        <PasswordField label={t('password')} name="password" autoComplete="current-password" required />
        <div className="flex justify-end">
          <Link
            href="/forgot-password"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {t('signIn.forgot')}
          </Link>
        </div>
        <Button type="submit" disabled={pending}>
          {t('signIn.submit')}
        </Button>
      </form>
      {googleEnabled ? (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Separator className="flex-1" />
            {t('signIn.or')}
            <Separator className="flex-1" />
          </div>
          <Button
            variant="outline"
            onClick={() =>
              void authClient().signIn.social({
                provider: 'google',
                callbackURL: new URL(next, window.location.origin).href,
              })
            }
          >
            {t('signIn.google')}
          </Button>
        </>
      ) : null}
    </AuthCard>
  );
}
