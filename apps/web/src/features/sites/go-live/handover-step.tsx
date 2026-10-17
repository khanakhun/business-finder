'use client';

import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Textarea } from '@bf/ui/components/textarea';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { getToast } from '@/lib/toast.tsx';
import {
  useExportSite,
  useHandoverActions,
  usePortalGrants,
  useSiteApprovals,
  useSiteChangeRequests,
  useSiteExports,
} from './api.ts';

// Handover (BF-062): invite the business owner to the client portal, ask them to approve a version (on the site's
// preview), read their change requests (also tasks on the business), and export the site as static files.

export function HandoverStep({ siteId, versionId }: { readonly siteId: string; readonly versionId: string }) {
  return (
    <div className="space-y-6">
      <Invites siteId={siteId} />
      <Approvals siteId={siteId} versionId={versionId} />
      <ChangeRequests siteId={siteId} />
      <Exports siteId={siteId} versionId={versionId} />
    </div>
  );
}

function Exports({ siteId, versionId }: { readonly siteId: string; readonly versionId: string }) {
  const t = useTranslations('goLive.handover');
  const format = useFormatter();
  const exports = useSiteExports(siteId);
  const exportSite = useExportSite(siteId);
  return (
    <section className="space-y-3">
      <h3 className="font-medium">{t('exportTitle')}</h3>
      <p className="text-sm text-muted-foreground">{t('exportHelp')}</p>
      <Button
        type="button"
        variant="outline"
        disabled={exportSite.isPending}
        onClick={() => void attempt(() => exportSite.mutateAsync(versionId), t('exportStarted'), t('failed'))}
      >
        {t('export')}
      </Button>
      {exports.data && exports.data.length > 0 ? (
        <ul className="divide-y rounded-lg border text-sm">
          {exports.data.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2 p-2">
              <span className="text-muted-foreground">
                {format.dateTime(new Date(item.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
              <Badge variant={item.status === 'failed' ? 'destructive' : 'secondary'}>
                {t(`exportStatus.${item.status}`)}
              </Badge>
              {item.bytes ? (
                <span>{format.number(item.bytes / 1_048_576, { maximumFractionDigits: 1 })} MB</span>
              ) : null}
              {item.downloadUrl ? (
                <a href={item.downloadUrl} className="ml-auto text-primary underline">
                  {t('download')}
                </a>
              ) : item.status === 'succeeded' ? (
                <span className="ml-auto text-muted-foreground">{t('linkExpired')}</span>
              ) : null}
              {item.error ? <p className="w-full text-destructive">{item.error}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

async function attempt(action: () => Promise<unknown>, success: string, failed: string) {
  const toast = await getToast();
  try {
    await action();
    toast.success(success);
    return true;
  } catch (error) {
    const problem = toProblemLike(error, failed);
    toast.error(problem.detail ?? problem.title);
    return false;
  }
}

function Invites({ siteId }: { readonly siteId: string }) {
  const t = useTranslations('goLive.handover');
  const format = useFormatter();
  const grants = usePortalGrants(siteId);
  const actions = useHandoverActions(siteId);
  const [email, setEmail] = React.useState('');
  const [locale, setLocale] = React.useState<'fr' | 'en'>('fr');
  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    const ok = await attempt(
      () => actions.invite.mutateAsync({ email: email.trim(), locale }),
      t('invited', { email: email.trim() }),
      t('failed'),
    );
    if (ok) setEmail('');
  };
  return (
    <section className="space-y-3">
      <h3 className="font-medium">{t('portalTitle')}</h3>
      <p className="text-sm text-muted-foreground">{t('portalHelp')}</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={invite}>
        <div className="min-w-56 flex-1 space-y-1">
          <Label htmlFor="handover-email">{t('email')}</Label>
          <Input
            id="handover-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <label className="space-y-1 text-sm" htmlFor="handover-locale">
          <span className="block font-medium">{t('language')}</span>
          <select
            id="handover-locale"
            className="h-9 rounded-md border border-input bg-transparent px-2"
            value={locale}
            onChange={(event) => setLocale(event.target.value === 'en' ? 'en' : 'fr')}
          >
            <option value="fr">Français</option>
            <option value="en">English</option>
          </select>
        </label>
        <Button type="submit" disabled={actions.invite.isPending || !email.trim()}>
          {t('invite')}
        </Button>
      </form>
      {!grants.data ? (
        <Skeleton className="h-10 w-full" />
      ) : grants.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noGrants')}</p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {grants.data.map((grant) => (
            <li key={grant.id} className="flex flex-wrap items-center gap-2 p-2">
              <span className="break-all">{grant.email}</span>
              <Badge variant={grant.acceptedAt ? 'secondary' : 'outline'}>
                {grant.acceptedAt
                  ? t('joined', {
                      date: format.dateTime(new Date(grant.acceptedAt), { dateStyle: 'medium' }),
                    })
                  : t('invitedOn', {
                      date: format.dateTime(new Date(grant.invitedAt), { dateStyle: 'medium' }),
                    })}
              </Badge>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={actions.revoke.isPending}
                onClick={() =>
                  void attempt(() => actions.revoke.mutateAsync(grant.id), t('revoked'), t('failed'))
                }
              >
                {t('revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Approvals({ siteId, versionId }: { readonly siteId: string; readonly versionId: string }) {
  const t = useTranslations('goLive.handover');
  const format = useFormatter();
  const approvals = useSiteApprovals(siteId);
  const actions = useHandoverActions(siteId);
  const [note, setNote] = React.useState('');
  const ask = async () => {
    const ok = await attempt(
      () => actions.requestApproval.mutateAsync({ versionId, note: note.trim() ? note.trim() : null }),
      t('asked'),
      t('failed'),
    );
    if (ok) setNote('');
  };
  return (
    <section className="space-y-3">
      <h3 className="font-medium">{t('approvalsTitle')}</h3>
      <p className="text-sm text-muted-foreground">{t('approvalsHelp')}</p>
      <div className="space-y-1">
        <Label htmlFor="handover-note">{t('note')}</Label>
        <Textarea
          id="handover-note"
          maxLength={1_000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={actions.requestApproval.isPending}
        onClick={() => void ask()}
      >
        {t('ask')}
      </Button>
      {approvals.data && approvals.data.length > 0 ? (
        <ul className="divide-y rounded-lg border text-sm">
          {approvals.data.map((approval) => (
            <li key={approval.id} className="space-y-1 p-2">
              <p className="flex flex-wrap items-center gap-2">
                {t('version', { n: approval.versionNumber })}
                <Badge variant={approval.status === 'changes_requested' ? 'destructive' : 'secondary'}>
                  {t(`status.${approval.status}`)}
                </Badge>
                <span className="text-muted-foreground">
                  {format.dateTime(new Date(approval.decidedAt ?? approval.requestedAt), {
                    dateStyle: 'medium',
                  })}
                </span>
              </p>
              {approval.comment ? <p className="whitespace-pre-line">{approval.comment}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ChangeRequests({ siteId }: { readonly siteId: string }) {
  const t = useTranslations('goLive.handover');
  const format = useFormatter();
  const requests = useSiteChangeRequests(siteId);
  return (
    <section className="space-y-3">
      <h3 className="font-medium">{t('changesTitle')}</h3>
      {!requests.data ? (
        <Skeleton className="h-10 w-full" />
      ) : requests.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noChanges')}</p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {requests.data.map((request) => (
            <li key={request.id} className="space-y-1 p-2">
              <p className="text-muted-foreground">
                {format.dateTime(new Date(request.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                {request.pageHint ? ` · ${request.pageHint}` : ''}
              </p>
              <p className="whitespace-pre-line">{request.message}</p>
              {request.attachments.length > 0 ? (
                <p className="flex flex-wrap gap-2">
                  {request.attachments.map((file, index) =>
                    file.url ? (
                      <a
                        key={file.id}
                        href={file.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary underline"
                      >
                        {t('screenshot', { n: index + 1 })}
                      </a>
                    ) : null,
                  )}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
