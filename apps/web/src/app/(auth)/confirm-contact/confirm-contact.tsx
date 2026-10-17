'use client';

import { Button } from '@bf/ui/components/button';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { confirmContactRouting } from '@/features/sites/go-live/api.ts';

/**
 * Confirms on a click, not on load: mail scanners open links, and an address must only be confirmed by its owner.
 * Unknown and expired tokens get the same answer.
 */
export function ConfirmContact({ token }: { readonly token: string }) {
  const t = useTranslations('goLive.confirmContact');
  const [state, setState] = React.useState<'idle' | 'busy' | 'confirmed' | 'invalid' | 'error'>(
    /^[A-Za-z0-9_-]{20,200}$/.test(token) ? 'idle' : 'invalid',
  );
  const confirm = async () => {
    setState('busy');
    try {
      setState((await confirmContactRouting(token)) ? 'confirmed' : 'invalid');
    } catch {
      setState('error');
    }
  };
  if (state === 'confirmed') return <p role="status">{t('confirmed')}</p>;
  if (state === 'invalid') return <p role="status">{t('invalid')}</p>;
  return (
    <div className="grid gap-3">
      <p>{t('body')}</p>
      {state === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {t('error')}
        </p>
      ) : null}
      <Button type="button" disabled={state === 'busy'} onClick={() => void confirm()}>
        {t('submit')}
      </Button>
    </div>
  );
}
