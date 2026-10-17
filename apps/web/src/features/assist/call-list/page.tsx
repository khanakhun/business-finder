'use client';

import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { PhoneIcon, WifiOffIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { useSession } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useCallList, useOutcomeSettled } from '../api.ts';
import { CallCard } from './card.tsx';
import { flushOutcomes, onQueueChange, queued } from './offline-queue.ts';

/**
 * Today's calls (BF-057), mobile first: open call tasks, then businesses worth calling now. Outcomes logged offline
 * wait in this browser and are sent once the connection is back.
 */
export function CallListPage() {
  const t = useTranslations('assist.list');
  const errorLabels = useErrorLabels();
  const { user } = useSession();
  const list = useCallList();
  const settled = useOutcomeSettled();
  const [waiting, setWaiting] = React.useState(0);
  const [online, setOnline] = React.useState(true);

  // The latest labels and invalidation, read by the listeners below (subscribed once per user).
  const latest = React.useRef({ settled, t });
  latest.current = { settled, t };

  React.useEffect(() => {
    let active = true;
    const count = () =>
      void queued(user.id).then((items) => {
        if (active) setWaiting(items.length);
      });
    const flush = async () => {
      setOnline(navigator.onLine);
      if (!navigator.onLine) return;
      const sent = await flushOutcomes(user.id);
      if (sent > 0) {
        (await getToast()).success(latest.current.t('synced', { count: sent }));
        latest.current.settled();
      }
    };
    const offline = () => setOnline(false);
    count();
    void flush();
    const unsubscribe = onQueueChange(count);
    window.addEventListener('online', flush);
    window.addEventListener('offline', offline);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('online', flush);
      window.removeEventListener('offline', offline);
    };
  }, [user.id]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {!online || waiting > 0 ? (
        <p className="flex items-center gap-2 rounded-lg border p-3 text-sm" role="status">
          <WifiOffIcon aria-hidden className="size-4" />
          {online ? t('waitingOnline', { count: waiting }) : t('offline', { count: waiting })}
        </p>
      ) : null}
      {list.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : !list.data ? (
        <ErrorState
          problem={toProblemLike(list.error, t('loadError'))}
          labels={errorLabels}
          onRetry={() => void list.refetch()}
        />
      ) : list.data.tasks.length === 0 && list.data.suggestions.length === 0 ? (
        <EmptyState
          icon={<PhoneIcon aria-hidden />}
          title={t('emptyTitle')}
          description={t('emptyBody')}
          action={
            <Button variant="outline" onClick={() => void list.refetch()}>
              {t('refresh')}
            </Button>
          }
        />
      ) : (
        <>
          <section className="space-y-3" aria-labelledby="calls-tasks">
            <h2 id="calls-tasks" className="text-lg font-semibold">
              {t('tasks', { count: list.data.tasks.length })}
            </h2>
            {list.data.tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noTasks')}</p>
            ) : (
              list.data.tasks.map((item) => <CallCard key={item.taskId ?? item.businessId} item={item} />)
            )}
          </section>
          <section className="space-y-3" aria-labelledby="calls-suggestions">
            <h2 id="calls-suggestions" className="text-lg font-semibold">
              {t('suggestions')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('suggestionsHint')}</p>
            {list.data.suggestions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noSuggestions')}</p>
            ) : (
              list.data.suggestions.map((item) => <CallCard key={item.businessId} item={item} />)
            )}
          </section>
        </>
      )}
    </div>
  );
}
