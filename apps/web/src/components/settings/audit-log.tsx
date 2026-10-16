'use client';

import type { ApiKeyList, AuditLogEntry, AuditLogPage, MembersOverview } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@bf/ui/components/table';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ScrollTextIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { usePermission } from '@/lib/session.tsx';
import { Forbidden } from './forbidden.tsx';

const GROUPS = ['settings', 'secrets', 'identity'] as const;
const ALL = 'all';
const PAGE_SIZE = 50;

export function AuditLog() {
  const t = useTranslations();
  const canManage = usePermission('settings:manage');
  const labels = useErrorLabels();
  const [group, setGroup] = React.useState<string>(ALL);
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const filters = React.useMemo(
    () => ({
      ...(group === ALL ? {} : { action: `${group}.` }),
      // Whole days in the viewer's time zone.
      ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
      ...(to ? { to: new Date(`${to}T23:59:59.999`).toISOString() } : {}),
    }),
    [group, from, to],
  );
  const query = useInfiniteQuery({
    queryKey: queryKeys.workspace.audit(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await apiClient().GET('/v1/audit-logs', {
          params: { query: { ...filters, limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) } },
        })
      ).data as AuditLogPage,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: canManage,
  });
  const actors = useActorNames(canManage);

  if (!canManage) return <Forbidden />;
  const entries = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="audit-action">{t('audit.filterAction')}</Label>
          <Select value={group} onValueChange={setGroup}>
            <SelectTrigger id="audit-action" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('audit.all')}</SelectItem>
              {GROUPS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`audit.groups.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-from">{t('audit.from')}</Label>
          <Input id="audit-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-to">{t('audit.to')}</Label>
          <Input id="audit-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {group !== ALL || from || to ? (
          <Button
            variant="ghost"
            onClick={() => {
              setGroup(ALL);
              setFrom('');
              setTo('');
            }}
          >
            {t('audit.clear')}
          </Button>
        ) : null}
      </div>

      {query.isError ? (
        <ErrorState
          problem={toProblemLike(query.error, t('errors.pageTitle'))}
          labels={labels}
          onRetry={() => void query.refetch()}
        />
      ) : !query.data ? (
        <Skeleton className="h-64" />
      ) : entries.length === 0 ? (
        <EmptyState icon={<ScrollTextIcon aria-hidden />} title={t('audit.empty')} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('audit.columns.when')}</TableHead>
                <TableHead>{t('audit.columns.actor')}</TableHead>
                <TableHead>{t('audit.columns.action')}</TableHead>
                <TableHead>{t('audit.columns.entity')}</TableHead>
                <TableHead>{t('audit.columns.ip')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <AuditRow key={entry.id} entry={entry} actors={actors} />
              ))}
            </TableBody>
          </Table>
          {query.hasNextPage ? (
            <div>
              <Button
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t('audit.loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Names for actor ids from lists the viewer can already read (members, API keys); others show a short id. */
function useActorNames(enabled: boolean): ReadonlyMap<string, string> {
  const canSeeMembers = usePermission('members:manage');
  const members = useQuery({
    queryKey: queryKeys.identity.members(),
    queryFn: async () => (await apiClient().GET('/v1/members')).data as MembersOverview,
    enabled: enabled && canSeeMembers,
  });
  const keys = useQuery({
    queryKey: queryKeys.identity.apiKeys(),
    queryFn: async () => (await apiClient().GET('/v1/api-keys')).data as ApiKeyList,
    enabled,
  });
  return React.useMemo(
    () =>
      new Map([
        ...(members.data?.members.map((m) => [m.userId, m.name] as const) ?? []),
        ...(keys.data?.items.map((k) => [k.id, k.name] as const) ?? []),
      ]),
    [members.data, keys.data],
  );
}

function AuditRow({
  entry,
  actors,
}: {
  readonly entry: AuditLogEntry;
  readonly actors: ReadonlyMap<string, string>;
}) {
  const t = useTranslations('audit');
  const format = useFormatter();
  const actionKey = `actions.${entry.action.replaceAll('.', '_')}`;
  const name = entry.actorId ? actors.get(entry.actorId) : undefined;
  const actor =
    entry.actorType === 'system'
      ? t('actorSystem')
      : entry.actorType === 'api_key'
        ? t('actorApiKey', { name: name ?? entry.actorId?.slice(0, 8) ?? '?' })
        : (name ?? t('removedActor', { id: entry.actorId?.slice(0, 8) ?? '?' }));
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">
        <time dateTime={entry.occurredAt}>
          {format.dateTime(new Date(entry.occurredAt), { dateStyle: 'medium', timeStyle: 'short' })}
        </time>
      </TableCell>
      <TableCell>{actor}</TableCell>
      {/* Known actions are translated; new ones show their code until they get a label. */}
      <TableCell>{t.has(actionKey as never) ? t(actionKey as never) : entry.action}</TableCell>
      <TableCell className="max-w-56 truncate font-mono text-xs">
        {entry.entityType
          ? `${entry.entityType}${entry.entityId ? ` · ${entry.entityId.slice(0, 36)}` : ''}`
          : '—'}
      </TableCell>
      <TableCell className="font-mono text-xs">{entry.ip ?? '—'}</TableCell>
    </TableRow>
  );
}
