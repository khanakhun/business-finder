'use client';

import type { SiteDomain, SiteDomainStatus } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import { EmptyState } from '@bf/ui/components/empty-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { CopyIcon, GlobeIcon, RefreshCwIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { getToast } from '@/lib/toast.tsx';
import { useGoLiveActions } from './api.ts';

// Custom domains (BF-062): the records to create at the registrar, the last DNS check (what was expected and what
// was found) and a re-check. A verified domain is served once the site is live (certificates are issued on demand).

const STATUS_VARIANT: Record<SiteDomainStatus, 'secondary' | 'outline' | 'destructive' | 'default'> = {
  pending_dns: 'outline',
  verifying: 'outline',
  verified: 'secondary',
  active: 'default',
  failed: 'destructive',
  removed: 'outline',
};

export function DomainStep({ siteId, domains }: { readonly siteId: string; readonly domains: SiteDomain[] }) {
  const t = useTranslations('goLive.domains');
  const actions = useGoLiveActions(siteId);
  const [hostname, setHostname] = React.useState('');
  const [includeWww, setIncludeWww] = React.useState(true);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const toast = await getToast();
    try {
      await actions.addDomain.mutateAsync({ hostname: hostname.trim(), includeWww });
      toast.success(t('added', { hostname: hostname.trim() }));
      setHostname('');
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={add}>
        <div className="min-w-56 flex-1 space-y-1">
          <Label htmlFor="domain-hostname">{t('hostname')}</Label>
          <Input
            id="domain-hostname"
            placeholder="salon.example"
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Checkbox
            id="domain-www"
            checked={includeWww}
            onCheckedChange={(checked) => setIncludeWww(checked === true)}
          />
          <Label htmlFor="domain-www" className="font-normal">
            {t('includeWww')}
          </Label>
        </div>
        <Button type="submit" disabled={actions.addDomain.isPending || !hostname.trim()}>
          {t('add')}
        </Button>
      </form>
      {domains.length === 0 ? (
        <EmptyState icon={<GlobeIcon aria-hidden />} title={t('emptyTitle')} description={t('emptyBody')} />
      ) : (
        <ul className="space-y-3">
          {domains.map((domain) => (
            <DomainCard key={domain.id} siteId={siteId} domain={domain} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DomainCard({ siteId, domain }: { readonly siteId: string; readonly domain: SiteDomain }) {
  const t = useTranslations('goLive.domains');
  const format = useFormatter();
  const actions = useGoLiveActions(siteId);
  const [confirmRemove, setConfirmRemove] = React.useState(false);

  const run = async (action: () => Promise<unknown>, success: string) => {
    const toast = await getToast();
    try {
      await action();
      toast.success(success);
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  const copy = async (value: string) => {
    const toast = await getToast();
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  return (
    <li className="space-y-3 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium break-all">{domain.hostname}</span>
        <Badge variant={STATUS_VARIANT[domain.status]}>{t(`status.${domain.status}`)}</Badge>
        {domain.redirectTo ? (
          <span className="text-muted-foreground">{t('redirects', { target: domain.redirectTo })}</span>
        ) : null}
        <span className="ml-auto flex gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={actions.checkDomain.isPending}
            onClick={() => void run(() => actions.checkDomain.mutateAsync(domain.id), t('checked'))}
          >
            <RefreshCwIcon aria-hidden />
            {t('check')}
          </Button>
          {confirmRemove ? (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={actions.removeDomain.isPending}
              onClick={() => void run(() => actions.removeDomain.mutateAsync(domain.id), t('removed'))}
            >
              {t('removeConfirm')}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
              {t('remove')}
            </Button>
          )}
        </span>
      </div>
      {domain.records.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{t('recordsCaption', { hostname: domain.hostname })}</caption>
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('type')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('name')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('value')}
                </th>
                <th scope="col" className="py-1 font-medium">
                  <span className="sr-only">{t('copy')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {domain.records.map((record) => (
                <tr key={`${record.type}:${record.name}:${record.value}`} className="border-t">
                  <td className="py-1 pr-3 font-mono">{record.type}</td>
                  <td className="py-1 pr-3 font-mono break-all">{record.name}</td>
                  <td className="py-1 pr-3 font-mono break-all">{record.value}</td>
                  <td className="py-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={t('copyValue', { value: record.value })}
                      onClick={() => void copy(record.value)}
                    >
                      <CopyIcon aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {domain.report ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {t('lastCheck', {
              date: format.dateTime(new Date(domain.report.checkedAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
          </p>
          <ul className="space-y-0.5 text-xs">
            {domain.report.checks.map((check) => (
              <li key={`${check.type}:${check.name}:${check.expected}`} className="break-all">
                <span className={check.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}>
                  {check.ok ? t('ok') : t('missing')}
                </span>{' '}
                <span className="font-mono">
                  {check.type} {check.name} → {check.expected}
                </span>
                {!check.ok ? (
                  <span className="text-muted-foreground">
                    {' '}
                    {check.found.length ? t('found', { values: check.found.join(', ') }) : t('foundNothing')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}
