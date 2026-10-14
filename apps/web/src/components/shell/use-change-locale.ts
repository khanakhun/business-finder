'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import { setLocale } from '@/i18n/actions.ts';

// Its own module (not preferences.tsx) so the shell can use it without pulling the menus into the first bundle.
/** Changes the dashboard language (cookie) and re-renders server components in it. */
export function useChangeLocale(): (locale: string) => void {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Stable identity: the shell builds its command list from this; a new function per render re-registered the
  // commands on every render (an infinite update loop that also cancelled navigation).
  return useCallback(
    (locale: string) =>
      startTransition(async () => {
        await setLocale(locale);
        router.refresh();
      }),
    [router],
  );
}
