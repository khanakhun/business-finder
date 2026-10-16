'use client';

import { Button } from '@bf/ui/components/button';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { AuthCard } from '@/components/auth/auth-card.tsx';
import { FormError, useErrorMessage } from '@/components/auth/fields.tsx';
import { authClient, unwrap } from '@/lib/auth-client.ts';

interface InvitationView {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly inviterEmail: string;
  readonly role: string;
}

export function AcceptInvitation({ invitationId }: { readonly invitationId: string }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const [invitation, setInvitation] = React.useState<InvitationView | null | 'invalid'>(null);
  const [state, setState] = React.useState<'idle' | 'pending' | 'declined'>('idle');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    unwrap(authClient().organization.getInvitation({ query: { id: invitationId } })).then(
      (data) => {
        if (!cancelled) setInvitation(data as InvitationView);
      },
      () => {
        if (!cancelled) setInvitation('invalid');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [invitationId]);

  if (invitation === null) {
    return (
      <AuthCard title={t('auth.invite.title')}>
        <Skeleton className="h-16" />
      </AuthCard>
    );
  }
  if (invitation === 'invalid') {
    return (
      <AuthCard title={t('auth.invite.title')}>
        <p role="alert">{t('auth.invite.invalid')}</p>
      </AuthCard>
    );
  }
  if (state === 'declined') {
    return (
      <AuthCard title={t('auth.invite.title')}>
        <p role="status">{t('auth.invite.declined')}</p>
      </AuthCard>
    );
  }

  const run = async (action: 'accept' | 'decline') => {
    setError(null);
    setState('pending');
    try {
      const orgs = authClient().organization;
      if (action === 'decline') {
        await unwrap(orgs.rejectInvitation({ invitationId }));
        setState('declined');
        return;
      }
      await unwrap(orgs.acceptInvitation({ invitationId }));
      // Best effort once accepted: retrying would fail ("already accepted"), and the dashboard still works.
      await unwrap(orgs.setActive({ organizationId: invitation.organizationId })).catch(() => undefined);
      window.location.assign('/');
    } catch (caught) {
      setError(errorMessage(caught));
      setState('idle');
    }
  };

  const role = (['owner', 'admin', 'member', 'viewer'] as const).find((r) => r === invitation.role);
  return (
    <AuthCard title={t('auth.invite.joinTitle', { organization: invitation.organizationName })}>
      <FormError message={error} />
      <p>
        {t('auth.invite.joinBody', {
          inviter: invitation.inviterEmail,
          role: role ? t(`roles.${role}`) : invitation.role,
        })}
      </p>
      <div className="grid gap-2">
        <Button onClick={() => void run('accept')} disabled={state === 'pending'}>
          {t('auth.invite.accept')}
        </Button>
        <Button variant="ghost" onClick={() => void run('decline')} disabled={state === 'pending'}>
          {t('auth.invite.decline')}
        </Button>
      </div>
    </AuthCard>
  );
}
