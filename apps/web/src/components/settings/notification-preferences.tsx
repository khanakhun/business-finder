'use client';

import type { NotificationPreference, NotificationPreferences } from '@bf/contracts';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Switch } from '@bf/ui/components/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@bf/ui/components/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { getToast } from '@/lib/toast.tsx';

/** Development-only types are not offered. */
const HIDDEN = new Set(['system_test']);

export function NotificationPreferencesSettings() {
  const t = useTranslations();
  const labels = useErrorLabels();
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.notifications.preferences(),
    queryFn: async () =>
      (await apiClient().GET('/v1/notifications/preferences')).data as NotificationPreferences,
  });
  const save = useMutation({
    mutationFn: async (item: NotificationPreference) =>
      (await apiClient().PUT('/v1/notifications/preferences', { body: { items: [item] } })).data,
    onSuccess: async (saved) => {
      client.setQueryData(queryKeys.notifications.preferences(), saved);
      (await getToast()).success(t('notifications.preferences.saved'));
    },
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });
  if (query.isError) {
    return (
      <ErrorState
        problem={toProblemLike(query.error, t('errors.pageTitle'))}
        labels={labels}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <Skeleton className="h-64 max-w-3xl" />;
  return (
    <div className="max-w-3xl rounded-lg border bg-surface">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('notifications.preferences.type')}</TableHead>
            <TableHead className="w-32 text-center">{t('notifications.preferences.inApp')}</TableHead>
            <TableHead className="w-32 text-center">{t('notifications.preferences.email')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {query.data.items
            .filter((item) => !HIDDEN.has(item.type))
            .map((item) => {
              const label = t(`notifications.preferences.types.${item.type}`);
              return (
                <TableRow key={item.type}>
                  <TableCell>{label}</TableCell>
                  <TableCell className="text-center">
                    <Switch
                      aria-label={`${t('notifications.preferences.inApp')} — ${label}`}
                      checked={item.inApp}
                      disabled={save.isPending}
                      onCheckedChange={(inApp) => save.mutate({ ...item, inApp })}
                    />
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      aria-label={`${t('notifications.preferences.email')} — ${label}`}
                      checked={item.email}
                      disabled={save.isPending}
                      onCheckedChange={(email) => save.mutate({ ...item, email })}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
        </TableBody>
      </Table>
    </div>
  );
}
