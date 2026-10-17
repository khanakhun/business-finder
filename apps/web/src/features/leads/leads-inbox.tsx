'use client';

import { LEAD_KINDS, LEAD_STATUSES, type SiteLead } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { PageHeader } from '@bf/ui/components/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { DownloadIcon, HandshakeIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { downloadFromApi } from '@/features/search/bulk-actions/bar.tsx';
import { usePermission } from '@/lib/session.tsx';
import { useLeads } from './api.ts';
import { LeadDrawer } from './lead-drawer.tsx';

// The leads inbox (BF-048): claims, contact requests and opt-outs from previews, newest first, by status and kind;
// a lead opens in a drawer (`?lead=`). Spam is hidden unless filtered on.

const ALL = 'all';
const STATUSES = [ALL, ...LEAD_STATUSES] as const;
const KINDS = [ALL, ...LEAD_KINDS] as const;

export function LeadsInbox() {
  const t = useTranslations('leads');
  const errorLabels = useErrorLabels();
  const format = useFormatter();
  const canExport = usePermission('leads:export');
  const [status, setStatus] = useQueryState('status', parseAsStringLiteral(STATUSES).withDefault(ALL));
  const [kind, setKind] = useQueryState('kind', parseAsStringLiteral(KINDS).withDefault(ALL));
  const [open, setOpen] = useQueryState('lead', parseAsString);
  const filters = {
    ...(status === ALL ? {} : { status }),
    ...(kind === ALL ? {} : { kind }),
  };
  const leads = useLeads(filters);
  const items = leads.data?.pages.flatMap((page) => page.items) ?? [];
  const channel = (lead: SiteLead) =>
    [lead.phone, lead.whatsapp ? `WhatsApp ${lead.whatsapp}` : null, lead.email].filter(Boolean).join(' · ');
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          canExport ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => downloadFromApi('/v1/leads/export.csv', filters)}
            >
              <DownloadIcon aria-hidden />
              {t('export')}
            </Button>
          ) : null
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={status} onValueChange={(value) => void setStatus(value as (typeof STATUSES)[number])}>
          <SelectTrigger size="sm" className="w-44" aria-label={t('filters.status')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {value === ALL ? t('filters.allStatuses') : t(`status.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={(value) => void setKind(value as (typeof KINDS)[number])}>
          <SelectTrigger size="sm" className="w-48" aria-label={t('filters.kind')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.map((value) => (
              <SelectItem key={value} value={value}>
                {value === ALL ? t('filters.allKinds') : t(`kind.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {leads.isError ? (
        <ErrorState
          problem={toProblemLike(leads.error, t('loadError'))}
          labels={errorLabels}
          onRetry={() => void leads.refetch()}
        />
      ) : leads.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={<HandshakeIcon aria-hidden />} title={t('empty')} description={t('emptyHint')} />
      ) : (
        <ul className="divide-y rounded-lg border" aria-label={t('title')}>
          {items.map((lead) => (
            <li key={lead.id}>
              <button
                type="button"
                className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-muted/50"
                onClick={() => void setOpen(lead.id)}
                data-lead-id={lead.id}
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{lead.businessName}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[lead.name, channel(lead)].filter(Boolean).join(' — ') || t('noDetails')}
                  </span>
                </span>
                <Badge variant={lead.kind === 'opt_out' ? 'destructive' : 'secondary'}>
                  {t(`kind.${lead.kind}`)}
                </Badge>
                <Badge variant={lead.status === 'new' ? 'default' : 'outline'}>
                  {t(`status.${lead.status}`)}
                </Badge>
                <time dateTime={lead.createdAt} className="text-xs text-muted-foreground">
                  {format.relativeTime(new Date(lead.createdAt))}
                </time>
              </button>
            </li>
          ))}
        </ul>
      )}
      {leads.hasNextPage ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-2"
          disabled={leads.isFetchingNextPage}
          onClick={() => void leads.fetchNextPage()}
        >
          {t('more')}
        </Button>
      ) : null}
      <LeadDrawer leadId={open} onClose={() => void setOpen(null)} />
    </>
  );
}
