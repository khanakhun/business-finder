'use client';

import { Button } from '@bf/ui/components/button';
import { useTranslations } from 'next-intl';
import { authClient, unwrap } from '@/lib/auth-client.ts';
import { getToast } from '@/lib/toast.tsx';

export function PortalSignOut() {
  const t = useTranslations('portal');
  const signOut = async () => {
    try {
      await unwrap(authClient().signOut());
      window.location.assign('/portal/sign-in');
    } catch {
      (await getToast()).error(t('signOutFailed'));
    }
  };
  return (
    <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()}>
      {t('signOut')}
    </Button>
  );
}
