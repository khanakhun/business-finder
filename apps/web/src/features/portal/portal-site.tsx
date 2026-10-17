'use client';

import { PORTAL_ATTACHMENT_MAX_BYTES, PORTAL_ATTACHMENT_TYPES, type SiteApproval } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@bf/ui/components/tabs';
import { Textarea } from '@bf/ui/components/textarea';
import { ExternalLinkIcon, InboxIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { getToast } from '@/lib/toast.tsx';
import {
  usePortalActions,
  usePortalApprovals,
  usePortalChangeRequests,
  usePortalLeads,
  usePortalSite,
  usePortalStats,
} from './api.ts';

// One of the client's sites (BF-062): its address and status with 30 days of views and leads, the contact requests,
// change requests (with screenshots) and the versions waiting for their approval.

function ExternalLink({ href, children }: { readonly href: string; readonly children: React.ReactNode }) {
  const t = useTranslations('portal');
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 break-all text-primary underline"
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
      <span className="sr-only">{t('opensNewTab')}</span>
    </a>
  );
}

export function PortalSiteView({ siteId }: { readonly siteId: string }) {
  const t = useTranslations('portal');
  const errorLabels = useErrorLabels();
  const site = usePortalSite(siteId);
  if (site.isError)
    return (
      <ErrorState
        problem={toProblemLike(site.error, t('loadError'))}
        labels={errorLabels}
        onRetry={() => void site.refetch()}
      />
    );
  if (!site.data) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{site.data.name}</h1>
        {site.data.liveUrl ? (
          <ExternalLink href={site.data.liveUrl}>{site.data.liveUrl}</ExternalLink>
        ) : (
          <p className="text-sm text-muted-foreground">{t('notLiveYet')}</p>
        )}
      </div>
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">{t('tabs.overview')}</TabsTrigger>
          <TabsTrigger value="leads">{t('tabs.leads')}</TabsTrigger>
          <TabsTrigger value="changes">{t('tabs.changes')}</TabsTrigger>
          <TabsTrigger value="approvals">
            {t('tabs.approvals')}
            {site.data.pendingApprovals > 0 ? (
              <Badge className="ml-1">{site.data.pendingApprovals}</Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Overview siteId={siteId} />
        </TabsContent>
        <TabsContent value="leads">
          <Leads siteId={siteId} />
        </TabsContent>
        <TabsContent value="changes">
          <ChangeRequests siteId={siteId} />
        </TabsContent>
        <TabsContent value="approvals">
          <Approvals siteId={siteId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Overview({ siteId }: { readonly siteId: string }) {
  const t = useTranslations('portal.overview');
  const format = useFormatter();
  const stats = usePortalStats(siteId);
  if (!stats.data) return <Skeleton className="h-32 w-full" />;
  const max = Math.max(1, ...stats.data.daily.map((day) => day.pageViews));
  const locales = Object.entries(stats.data.byLocale).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 sm:grid-cols-3">
        {[
          { label: t('views', { days: stats.data.days }), value: stats.data.pageViews },
          { label: t('visitors', { days: stats.data.days }), value: stats.data.uniqueEstimate },
          { label: t('leads', { days: stats.data.days }), value: stats.data.leads },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border p-3">
            <dt className="text-sm text-muted-foreground">{item.label}</dt>
            <dd className="text-2xl font-semibold">{format.number(item.value)}</dd>
          </div>
        ))}
      </dl>
      {stats.data.daily.length > 0 ? (
        <figure className="space-y-1">
          <figcaption className="text-sm font-medium">{t('daily')}</figcaption>
          <div className="flex h-24 items-end gap-0.5" aria-hidden>
            {stats.data.daily.map((day) => (
              <div
                key={day.day}
                className="flex-1 rounded-t bg-primary/70"
                style={{ height: `${Math.max(2, (day.pageViews / max) * 100)}%` }}
                title={`${day.day}: ${day.pageViews}`}
              />
            ))}
          </div>
          <table className="sr-only">
            <caption>{t('daily')}</caption>
            <tbody>
              {stats.data.daily.map((day) => (
                <tr key={day.day}>
                  <th scope="row">{day.day}</th>
                  <td>{day.pageViews}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </figure>
      ) : (
        <p className="text-sm text-muted-foreground">{t('noViews')}</p>
      )}
      {locales.length > 0 ? (
        <div className="space-y-1 text-sm">
          <h2 className="font-medium">{t('byLanguage')}</h2>
          <ul className="flex flex-wrap gap-2">
            {locales.map(([locale, count]) => (
              <li key={locale}>
                <Badge variant="secondary">
                  {locale.toUpperCase()} · {format.number(count)}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Leads({ siteId }: { readonly siteId: string }) {
  const t = useTranslations('portal.leads');
  const format = useFormatter();
  const leads = usePortalLeads(siteId);
  if (!leads.data) return <Skeleton className="h-32 w-full" />;
  if (leads.data.length === 0)
    return (
      <EmptyState icon={<InboxIcon aria-hidden />} title={t('emptyTitle')} description={t('emptyBody')} />
    );
  return (
    <ul className="divide-y rounded-lg border">
      {leads.data.map((lead) => (
        <li key={lead.id} className="space-y-1 p-3 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{lead.name ?? t('anonymous')}</span>
            <span className="text-muted-foreground">
              {format.dateTime(new Date(lead.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
          </p>
          <p className="flex flex-wrap gap-3 text-muted-foreground">
            {lead.email ? <a href={`mailto:${lead.email}`}>{lead.email}</a> : null}
            {lead.phone ? <a href={`tel:${lead.phone}`}>{lead.phone}</a> : null}
          </p>
          {lead.message ? <p className="whitespace-pre-line">{lead.message}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function ChangeRequests({ siteId }: { readonly siteId: string }) {
  const t = useTranslations('portal.changes');
  const format = useFormatter();
  const requests = usePortalChangeRequests(siteId);
  const actions = usePortalActions(siteId);
  const [message, setMessage] = React.useState('');
  const [pageHint, setPageHint] = React.useState('');
  const [files, setFiles] = React.useState<File[]>([]);
  const [fileKey, setFileKey] = React.useState(0);

  const pick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = [...(event.target.files ?? [])];
    const valid = picked.filter(
      (file) =>
        (PORTAL_ATTACHMENT_TYPES as readonly string[]).includes(file.type) &&
        file.size <= PORTAL_ATTACHMENT_MAX_BYTES,
    );
    if (valid.length !== picked.length || valid.length > 3) (await getToast()).error(t('filesRefused'));
    setFiles(valid.slice(0, 3));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const toast = await getToast();
    try {
      await actions.changeRequest.mutateAsync({
        request: { message: message.trim(), pageHint: pageHint.trim() ? pageHint.trim() : null },
        files,
      });
      toast.success(t('sent'));
      setMessage('');
      setPageHint('');
      setFiles([]);
      setFileKey((key) => key + 1);
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };

  return (
    <div className="space-y-6">
      <form className="space-y-3" onSubmit={submit}>
        <p className="text-sm text-muted-foreground">{t('help')}</p>
        <div className="space-y-1">
          <Label htmlFor="change-message">{t('message')} *</Label>
          <Textarea
            id="change-message"
            required
            minLength={5}
            maxLength={4_000}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="change-page">{t('page')}</Label>
          <Input
            id="change-page"
            maxLength={200}
            value={pageHint}
            onChange={(event) => setPageHint(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="change-files">{t('screenshots')}</Label>
          <Input
            key={fileKey}
            id="change-files"
            type="file"
            multiple
            accept={PORTAL_ATTACHMENT_TYPES.join(',')}
            onChange={(event) => void pick(event)}
          />
          <p className="text-xs text-muted-foreground">{t('screenshotsHelp')}</p>
        </div>
        <Button type="submit" disabled={actions.changeRequest.isPending || message.trim().length < 5}>
          {t('submit')}
        </Button>
      </form>
      <section className="space-y-2">
        <h2 className="font-medium">{t('sentTitle')}</h2>
        {!requests.data ? (
          <Skeleton className="h-16 w-full" />
        ) : requests.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('none')}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {requests.data.map((request) => (
              <li key={request.id} className="space-y-1 p-3 text-sm">
                <p className="text-muted-foreground">
                  {format.dateTime(new Date(request.createdAt), { dateStyle: 'medium' })}
                  {request.pageHint ? ` · ${request.pageHint}` : ''}
                  {request.attachments.length > 0
                    ? ` · ${t('withScreenshots', { count: request.attachments.length })}`
                    : ''}
                </p>
                <p className="whitespace-pre-line">{request.message}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Approvals({ siteId }: { readonly siteId: string }) {
  const t = useTranslations('portal.approvals');
  const approvals = usePortalApprovals(siteId);
  if (!approvals.data) return <Skeleton className="h-24 w-full" />;
  if (approvals.data.length === 0) return <p className="text-sm text-muted-foreground">{t('none')}</p>;
  return (
    <ul className="space-y-3">
      {approvals.data.map((approval) => (
        <ApprovalCard key={approval.id} siteId={siteId} approval={approval} />
      ))}
    </ul>
  );
}

function ApprovalCard({ siteId, approval }: { readonly siteId: string; readonly approval: SiteApproval }) {
  const t = useTranslations('portal.approvals');
  const format = useFormatter();
  const actions = usePortalActions(siteId);
  const [comment, setComment] = React.useState('');
  const decide = async (decision: 'approved' | 'changes_requested') => {
    const toast = await getToast();
    try {
      await actions.decide.mutateAsync({
        approvalId: approval.id,
        decision: { decision, comment: comment.trim() ? comment.trim() : null },
      });
      toast.success(decision === 'approved' ? t('approvedToast') : t('changesToast'));
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  return (
    <li className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t('version', { n: approval.versionNumber })}</span>
        <Badge variant={approval.status === 'pending' ? 'default' : 'secondary'}>
          {t(`status.${approval.status}`)}
        </Badge>
        <span className="text-muted-foreground">
          {format.dateTime(new Date(approval.requestedAt), { dateStyle: 'medium' })}
        </span>
      </p>
      {approval.note ? <p className="whitespace-pre-line">{approval.note}</p> : null}
      {approval.previewUrl ? (
        <ExternalLink href={approval.previewUrl}>{t('look')}</ExternalLink>
      ) : (
        <p className="text-muted-foreground">{t('noPreview')}</p>
      )}
      {approval.comment ? (
        <p className="text-muted-foreground">{t('yourComment', { comment: approval.comment })}</p>
      ) : null}
      {approval.status === 'pending' ? (
        <div className="space-y-2">
          <Label htmlFor={`approval-${approval.id}`}>{t('comment')}</Label>
          <Textarea
            id={`approval-${approval.id}`}
            maxLength={4_000}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={actions.decide.isPending} onClick={() => void decide('approved')}>
              {t('approve')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={actions.decide.isPending || !comment.trim()}
              onClick={() => void decide('changes_requested')}
            >
              {t('requestChanges')}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
