'use client';

import { Button } from '@bf/ui/components/button';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import { authClient, unwrap } from '@/lib/auth-client.ts';

/**
 * The portal's sign-in (BF-062): a link by email. The answer is the same whether or not the address has access
 * (the API sends links only to invited business owners).
 */
export function PortalSignInForm() {
  const t = useTranslations('portal.signIn');
  const locale = useLocale();
  const [email, setEmail] = React.useState('');
  const [state, setState] = React.useState<'idle' | 'busy' | 'sent' | 'error'>('idle');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setState('busy');
    try {
      await unwrap(
        authClient().signIn.magicLink({
          email: email.trim(),
          callbackURL: `${window.location.origin}/portal`,
          errorCallbackURL: `${window.location.origin}/portal/sign-in?error=link`,
          metadata: { locale },
        }),
      );
      setState('sent');
    } catch {
      setState('error');
    }
  };
  if (state === 'sent') return <p role="status">{t('sent', { email: email.trim() })}</p>;
  return (
    <form className="grid gap-3" onSubmit={submit}>
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      <div className="grid gap-1">
        <Label htmlFor="portal-email">{t('email')}</Label>
        <Input
          id="portal-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      {state === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {t('error')}
        </p>
      ) : null}
      <Button type="submit" disabled={state === 'busy' || !email.trim()}>
        {t('submit')}
      </Button>
    </form>
  );
}
