'use client';

import { DSR_TYPES, type DsrDiscovery, type DsrRequest, type DsrType } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@bf/ui/components/sheet';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Textarea } from '@bf/ui/components/textarea';
import { DownloadIcon, FileSearchIcon, PlusIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { downloadFromApi } from '@/features/search/bulk-actions/bar.tsx';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useDsrActions, useDsrRequests } from './api.ts';

// Compliance → Data requests (BF-055): the workspace's access, erasure, objection, rectification and restriction
// requests with their deadline; owners verify, discover, carry out and download.

const METHODS = ['email_reply', 'known_contact', 'id_document', 'other'] as const;

export function RequestsPage() {
  const t = useTranslations('complianceAdmin.requests');
  const type = useTranslations('complianceAdmin.dsrTypes');
  const status = useTranslations('complianceAdmin.dsrStatus');
  const errorLabels = useErrorLabels();
  const format = useFormatter();
  const requests = useDsrRequests();
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = useQueryState('request', parseAsString);
  const current = requests.data?.find((request) => request.id === selected) ?? null;
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)}>
          <PlusIcon aria-hidden />
          {t('new')}
        </Button>
      </div>
      {requests.isError ? (
        <ErrorState
          problem={toProblemLike(requests.error, t('loadError'))}
          labels={errorLabels}
          onRetry={() => void requests.refetch()}
        />
      ) : !requests.data ? (
        <Skeleton className="h-40 w-full" />
      ) : requests.data.length === 0 ? (
        <EmptyState
          icon={<FileSearchIcon aria-hidden />}
          title={t('emptyTitle')}
          description={t('emptyBody')}
        />
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {requests.data.map((request) => {
            const overdue =
              request.status !== 'completed' &&
              request.status !== 'rejected' &&
              Date.parse(request.dueAt) < Date.now();
            return (
              <li key={request.id}>
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left hover:bg-muted/60"
                  onClick={() => void setSelected(request.id)}
                >
                  <span className="font-medium">{type(request.type)}</span>
                  <Badge variant="outline">{status(request.status)}</Badge>
                  <span className="text-muted-foreground">
                    {request.subject?.email ?? request.subject?.name ?? t('erasedSubject')}
                  </span>
                  <span
                    className={`ml-auto text-xs ${overdue ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {t('due', { when: format.dateTime(new Date(request.dueAt), { dateStyle: 'medium' }) })}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <CreateDialog open={creating} onOpenChange={setCreating} />
      <Sheet open={current !== null} onOpenChange={(open) => (open ? undefined : void setSelected(null))}>
        <SheetContent side="right" className="w-full overflow-y-auto p-5 sm:max-w-xl">
          <SheetTitle className="sr-only">{t('detail')}</SheetTitle>
          <SheetDescription className="sr-only">{t('detailHint')}</SheetDescription>
          {current ? <RequestDetail key={current.updatedAt} request={current} /> : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function CreateDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('complianceAdmin.requests');
  const typeName = useTranslations('complianceAdmin.dsrTypes');
  const { create } = useDsrActions();
  const [type, setType] = React.useState<DsrType>('access');
  const [email, setEmail] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [name, setName] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const toast = await getToast();
    try {
      await create.mutateAsync({
        type,
        subject: { ...(email ? { email } : {}), ...(phone ? { phone } : {}), ...(name ? { name } : {}) },
        ...(notes ? { notes } : {}),
      });
      toast.success(t('created'));
      onOpenChange(false);
    } catch (error) {
      toast.error(toProblemLike(error, t('failed')).title);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('new')}</DialogTitle>
          <DialogDescription>{t('newHint')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(event) => void submit(event)}>
          <div className="space-y-1">
            <Label htmlFor="dsr-type">{t('type')}</Label>
            <Select value={type} onValueChange={(next) => setType(next as DsrType)}>
              <SelectTrigger id="dsr-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DSR_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {typeName(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="dsr-email">{t('email')}</Label>
              <Input
                id="dsr-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dsr-phone">{t('phone')}</Label>
              <Input id="dsr-phone" value={phone} onChange={(event) => setPhone(event.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="dsr-name">{t('name')}</Label>
            <Input id="dsr-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dsr-notes">{t('notes')}</Label>
            <Textarea
              id="dsr-notes"
              rows={3}
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending || !(email || phone || name)}>
              {t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RequestDetail({ request }: { readonly request: DsrRequest }) {
  const t = useTranslations('complianceAdmin.requests');
  const typeName = useTranslations('complianceAdmin.dsrTypes');
  const status = useTranslations('complianceAdmin.dsrStatus');
  const method = useTranslations('complianceAdmin.methods');
  const format = useFormatter();
  const canExecute = usePermission('compliance:manage');
  const actions = useDsrActions();
  const [verifyMethod, setVerifyMethod] = React.useState<(typeof METHODS)[number]>('email_reply');
  const [verifyNotes, setVerifyNotes] = React.useState('');
  const [rejectReason, setRejectReason] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [mode, setMode] = React.useState<'anonymize' | 'delete'>('anonymize');
  const [discovery, setDiscovery] = React.useState<DsrDiscovery | null>(null);
  const run = async (action: () => Promise<unknown>, done: string) => {
    const toast = await getToast();
    try {
      await action();
      toast.success(done);
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  const open = request.status !== 'completed' && request.status !== 'rejected';
  return (
    <div className="space-y-5 text-sm">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{typeName(request.type)}</h2>
        <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <Badge variant="outline">{status(request.status)}</Badge>
          {t('due', { when: format.dateTime(new Date(request.dueAt), { dateStyle: 'medium' }) })}
          <Badge variant="secondary">{t(`source.${request.source}`)}</Badge>
        </p>
      </header>
      <section className="space-y-1">
        <h3 className="font-medium">{t('subject')}</h3>
        {request.subject ? (
          <dl className="grid grid-cols-[8rem_1fr] gap-1">
            {(['email', 'phone', 'name'] as const).map((key) =>
              request.subject?.[key] ? (
                <React.Fragment key={key}>
                  <dt className="text-muted-foreground">{t(key)}</dt>
                  <dd>{request.subject[key]}</dd>
                </React.Fragment>
              ) : null,
            )}
          </dl>
        ) : (
          <p className="text-muted-foreground">{t('erasedSubject')}</p>
        )}
      </section>
      {canExecute && open ? (
        <section className="space-y-3 rounded-lg border p-3">
          {request.status !== 'in_progress' ? (
            <>
              <h3 className="font-medium">{t('verifyTitle')}</h3>
              <div className="space-y-1">
                <Label htmlFor="verify-method">{t('method')}</Label>
                <Select
                  value={verifyMethod}
                  onValueChange={(value) => setVerifyMethod(value as (typeof METHODS)[number])}
                >
                  <SelectTrigger id="verify-method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METHODS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {method(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Textarea
                aria-label={t('verifyNotes')}
                placeholder={t('verifyNotes')}
                rows={2}
                value={verifyNotes}
                onChange={(event) => setVerifyNotes(event.target.value)}
              />
              <Button
                size="sm"
                disabled={verifyNotes.trim().length < 3}
                onClick={() =>
                  void run(
                    () =>
                      actions.verify.mutateAsync({
                        id: request.id,
                        body: { method: verifyMethod, notes: verifyNotes },
                      }),
                    t('verified'),
                  )
                }
              >
                {t('verify')}
              </Button>
            </>
          ) : (
            <>
              <h3 className="font-medium">{t('executeTitle')}</h3>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void run(
                    async () => setDiscovery(await actions.discover.mutateAsync(request.id)),
                    t('discovered'),
                  )
                }
              >
                {t('discover')}
              </Button>
              {discovery ? (
                <ul className="space-y-1 text-xs">
                  {discovery.providers.map((provider) => (
                    <li key={provider.id}>
                      <span className="font-medium">{provider.id}</span> —{' '}
                      {t('records', { count: provider.records })}
                      {provider.manualReview && provider.records > 0 ? ` · ${t('manualReview')}` : ''}
                      {provider.sample.length > 0 ? (
                        <span className="block text-muted-foreground">{provider.sample.join(' · ')}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {request.type === 'erasure' ? (
                <div className="space-y-1">
                  <Label htmlFor="erase-mode">{t('mode')}</Label>
                  <Select value={mode} onValueChange={(value) => setMode(value as 'anonymize' | 'delete')}>
                    <SelectTrigger id="erase-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="anonymize">{t('anonymize')}</SelectItem>
                      <SelectItem value="delete">{t('delete')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {request.type === 'rectification' || request.type === 'restriction' ? (
                <Textarea
                  aria-label={t('whatWasDone')}
                  placeholder={t('whatWasDone')}
                  rows={2}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
              ) : null}
              <Button
                size="sm"
                variant={request.type === 'erasure' ? 'destructive' : 'default'}
                onClick={() =>
                  void run(
                    () =>
                      actions.execute.mutateAsync({
                        id: request.id,
                        body: { mode, ...(notes ? { notes } : {}) },
                      }),
                    t('executed'),
                  )
                }
              >
                {t(`execute.${request.type}`)}
              </Button>
            </>
          )}
          <div className="flex gap-2 border-t pt-3">
            <Input
              aria-label={t('rejectReason')}
              placeholder={t('rejectReason')}
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={rejectReason.trim().length < 3}
              onClick={() =>
                void run(
                  () => actions.reject.mutateAsync({ id: request.id, body: { reason: rejectReason } }),
                  t('rejected'),
                )
              }
            >
              {t('reject')}
            </Button>
          </div>
        </section>
      ) : null}
      {request.exportReady && canExecute ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => downloadFromApi(`/v1/compliance/dsr/${request.id}/export.zip`, {})}
        >
          <DownloadIcon aria-hidden />
          {t('download')}
        </Button>
      ) : null}
      <section className="space-y-1">
        <h3 className="font-medium">{t('trail')}</h3>
        <ol className="space-y-0.5 text-xs text-muted-foreground">
          {request.actions.map((action) => (
            <li key={`${action.at}-${action.kind}`}>
              {format.dateTime(new Date(action.at), { dateStyle: 'short', timeStyle: 'short' })} ·{' '}
              {t(`actions.${action.kind}` as never)}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
