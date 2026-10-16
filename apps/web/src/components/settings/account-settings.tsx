'use client';

import type { Locale } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { ErrorState } from '@bf/ui/components/error-state';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { Field, FormError, PasswordField, useErrorMessage } from '@/components/auth/fields.tsx';
import { QrCode } from '@/components/auth/qr-code.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { LOCALES } from '@/i18n/locales.ts';
import { queryKeys } from '@/lib/api.ts';
import { authClient, unwrap } from '@/lib/auth-client.ts';
import { useSession } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { SettingsSection } from './section.tsx';

export function AccountSettings({ minPasswordLength }: { readonly minPasswordLength: number }) {
  return (
    <div className="grid gap-6">
      <ProfileSection />
      <PasswordSection minPasswordLength={minPasswordLength} />
      <TwoFactorSection />
      <SessionsSection />
    </div>
  );
}

function ProfileSection() {
  const t = useTranslations();
  const { user } = useSession();
  const errorMessage = useErrorMessage();
  const [locale, setLocale] = React.useState<Locale>(user.locale);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name')).trim();
    setError(null);
    setPending(true);
    try {
      await unwrap(authClient().updateUser({ name, locale }));
      (await getToast()).success(t('account.saved'));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsSection id="profile" title={t('account.profile')}>
      <form className="grid max-w-md gap-4" onSubmit={onSubmit}>
        <FormError message={error} />
        <Field label={t('auth.name')} name="name" defaultValue={user.name} required autoComplete="name" />
        <Field label={t('auth.email')} value={user.email} readOnly disabled />
        <div className="grid gap-1.5">
          <Label htmlFor="email-language">{t('account.language')}</Label>
          <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
            <SelectTrigger id="email-language" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCALES.map((code) => (
                <SelectItem key={code} value={code}>
                  {t(`language.${code}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Button type="submit" disabled={pending}>
            {t('account.save')}
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

function PasswordSection({ minPasswordLength }: { readonly minPasswordLength: number }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError(null);
    setPending(true);
    try {
      await unwrap(
        authClient().changePassword({
          currentPassword: String(data.get('currentPassword')),
          newPassword: String(data.get('newPassword')),
          revokeOtherSessions: true,
        }),
      );
      form.reset();
      (await getToast()).success(t('account.passwordChanged'));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsSection id="password" title={t('account.password')}>
      <form className="grid max-w-md gap-4" onSubmit={onSubmit}>
        <FormError message={error} />
        <PasswordField
          label={t('account.currentPassword')}
          name="currentPassword"
          autoComplete="current-password"
          required
        />
        <PasswordField
          label={t('auth.newPassword')}
          name="newPassword"
          autoComplete="new-password"
          required
          minLength={minPasswordLength}
          hint={t('auth.passwordHint', { min: minPasswordLength })}
        />
        <div>
          <Button type="submit" disabled={pending}>
            {t('account.changePassword')}
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

type TwoFactorStep =
  | { readonly step: 'idle' }
  | { readonly step: 'password'; readonly action: 'enable' | 'disable' }
  | { readonly step: 'scan'; readonly totpURI: string; readonly backupCodes: string[] }
  | { readonly step: 'codes'; readonly backupCodes: string[] };

function TwoFactorSection() {
  const t = useTranslations();
  const { user } = useSession();
  const errorMessage = useErrorMessage();
  const [enabled, setEnabled] = React.useState(user.twoFactorEnabled);
  const [state, setState] = React.useState<TwoFactorStep>({ step: 'idle' });
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setPending(true);
    try {
      await fn();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  const onPassword = (event: React.FormEvent<HTMLFormElement>, action: 'enable' | 'disable') => {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password'));
    void run(async () => {
      if (action === 'disable') {
        await unwrap(authClient().twoFactor.disable({ password }));
        setEnabled(false);
        setState({ step: 'idle' });
        return;
      }
      const result = await unwrap(authClient().twoFactor.enable({ password }));
      if (result.method !== 'totp') throw new Error('TOTP setup expected');
      setState({ step: 'scan', totpURI: result.totpURI, backupCodes: result.backupCodes });
    });
  };

  const onVerify = (event: React.FormEvent<HTMLFormElement>, backupCodes: string[]) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code')).replaceAll(/\s/g, '');
    void run(async () => {
      await unwrap(authClient().twoFactor.verifyTotp({ code }));
      setEnabled(true);
      setState({ step: 'codes', backupCodes });
    });
  };

  const status = (
    <Badge variant={enabled ? 'default' : 'secondary'}>
      {enabled ? t('account.twoFactorOn') : t('account.twoFactorOff')}
    </Badge>
  );
  return (
    <SettingsSection
      id="two-factor"
      title={t('account.twoFactor')}
      description={t('account.twoFactorDescription')}
      action={
        <div className="flex items-center gap-3">
          {status}
          {state.step === 'idle' ? (
            <Button
              variant="outline"
              onClick={() => setState({ step: 'password', action: enabled ? 'disable' : 'enable' })}
            >
              {enabled ? t('account.disable') : t('account.enable')}
            </Button>
          ) : null}
        </div>
      }
    >
      {state.step === 'idle' ? null : (
        <div className="grid max-w-md gap-4">
          <FormError message={error} />
          {state.step === 'password' ? (
            <form className="grid gap-4" onSubmit={(event) => onPassword(event, state.action)}>
              <PasswordField
                label={t('account.confirmPassword')}
                name="password"
                autoComplete="current-password"
                required
                autoFocus
              />
              <div className="flex gap-2">
                <Button type="submit" disabled={pending}>
                  {state.action === 'enable' ? t('account.enable') : t('account.disable')}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setState({ step: 'idle' })}>
                  {t('members.cancel')}
                </Button>
              </div>
            </form>
          ) : null}
          {state.step === 'scan' ? (
            <form className="grid gap-4" onSubmit={(event) => onVerify(event, state.backupCodes)}>
              <p>{t('account.scan')}</p>
              <QrCode value={state.totpURI} label={t('account.scan')} />
              <p className="text-sm text-muted-foreground">
                {t('account.secretFallback')}{' '}
                <code className="break-all font-mono">
                  {new URL(state.totpURI).searchParams.get('secret')}
                </code>
              </p>
              <Field
                label={t('auth.twoFactor.code')}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
              <div>
                <Button type="submit" disabled={pending}>
                  {t('account.verifyAndEnable')}
                </Button>
              </div>
            </form>
          ) : null}
          {state.step === 'codes' ? (
            <div className="grid gap-3">
              <h3 className="font-medium">{t('account.backupCodes')}</h3>
              <p className="text-muted-foreground">{t('account.backupCodesHint')}</p>
              <ul className="grid grid-cols-2 gap-2 font-mono text-sm" data-testid="backup-codes">
                {state.backupCodes.map((code) => (
                  <li key={code} className="rounded border px-2 py-1">
                    {code}
                  </li>
                ))}
              </ul>
              <div>
                <Button onClick={() => setState({ step: 'idle' })}>{t('account.done')}</Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </SettingsSection>
  );
}

interface SessionRow {
  readonly id: string;
  readonly token: string;
  readonly userAgent?: string | null;
  readonly createdAt: Date | string;
}

function SessionsSection() {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const labels = useErrorLabels();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.identity.sessions(),
    queryFn: async () => {
      const [list, current] = await Promise.all([
        unwrap(authClient().listSessions()),
        unwrap(authClient().getSession()),
      ]);
      return { sessions: list as SessionRow[], currentToken: current?.session.token ?? null };
    },
  });
  const revoke = useMutation({
    mutationFn: (token: string | null) =>
      token ? unwrap(authClient().revokeSession({ token })) : unwrap(authClient().revokeOtherSessions()),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.identity.sessions() }),
    onError: async (error) => (await getToast()).error(errorMessage(error)),
  });

  return (
    <SettingsSection
      id="sessions"
      title={t('account.sessions')}
      action={
        <Button
          variant="outline"
          disabled={revoke.isPending || !query.data}
          onClick={() => revoke.mutate(null)}
        >
          {t('account.revokeOthers')}
        </Button>
      }
    >
      {query.isError ? (
        <ErrorState
          problem={toProblemLike(query.error, t('errors.pageTitle'))}
          labels={labels}
          onRetry={() => void query.refetch()}
        />
      ) : query.data ? (
        <ul className="grid gap-2">
          {query.data.sessions.map((session) => (
            <li
              key={session.id}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate">{session.userAgent || t('account.unknownDevice')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('account.signedIn', {
                    date: format.dateTime(new Date(session.createdAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }),
                  })}
                </p>
              </div>
              {session.token === query.data.currentToken ? (
                <Badge variant="secondary">{t('account.thisDevice')}</Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(session.token)}
                >
                  {t('account.revoke')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Skeleton className="h-16" aria-label={t('account.sessionsLoading')} />
      )}
    </SettingsSection>
  );
}
