'use client';

import { type EmailPurpose, OFFERS, type Offer } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
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
import { Skeleton } from '@bf/ui/components/skeleton';
import { Textarea } from '@bf/ui/components/textarea';
import { cn } from '@bf/ui/lib/utils';
import { CheckCheckIcon, InboxIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { getToast } from '@/lib/toast.tsx';
import { useDraft } from '../api.ts';
import { useBulkActions, useBulkRun, useBulkRuns, useMessageActions } from '../outbound-api.ts';

// Approvals (BF-052): bulk runs and their items — each drafted for one business and judged by the compliance gate —
// waiting for a person. Approve one, several, or all (with the count confirmed); reject; edit a draft inline. The
// businesses a run skipped are listed with the gate's reasons and alternatives. Nothing here sends by itself: an
// approved item is judged again and queued like a one-click send.

type BulkRunDetail = NonNullable<ReturnType<typeof useBulkRun>['data']>;
const DECISIONS = ['allowed', 'allowed_with_conditions', 'manual_only', 'blocked', 'error'] as const;
const decisionKey = (value: string) =>
  `decision.${(DECISIONS as readonly string[]).includes(value) ? (value as (typeof DECISIONS)[number]) : 'error'}` as const;
type Item = BulkRunDetail['items'][number];

export function ApprovalsPage() {
  const t = useTranslations('outbound.approvals');
  const errorLabels = useErrorLabels();
  const [runId, setRunId] = useQueryState('run', parseAsString);
  const [ids, setIds] = useQueryState('ids', parseAsString);
  const runs = useBulkRuns();
  const selected = runId ?? runs.data?.[0]?.id ?? null;
  return (
    <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
      <aside className="space-y-3">
        {ids ? (
          <StartRun
            businessIds={ids.split(',').filter(Boolean)}
            onStarted={(id) => {
              void setIds(null);
              void setRunId(id);
            }}
          />
        ) : null}
        <h2 className="text-sm font-medium">{t('runs')}</h2>
        {runs.isError ? (
          <ErrorState
            problem={toProblemLike(runs.error, t('loadError'))}
            labels={errorLabels}
            onRetry={() => void runs.refetch()}
          />
        ) : !runs.data ? (
          <Skeleton className="h-32 w-full" />
        ) : runs.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noRuns')}</p>
        ) : (
          <ul className="space-y-1">
            {runs.data.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  aria-current={run.id === selected ? 'true' : undefined}
                  onClick={() => void setRunId(run.id)}
                  className={cn(
                    'w-full rounded-md border px-3 py-2 text-left text-sm',
                    run.id === selected ? 'border-primary bg-muted' : 'hover:bg-muted',
                  )}
                >
                  <RunLabel run={run} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <section className="min-w-0">
        {selected ? (
          <RunDetail id={selected} />
        ) : (
          <EmptyState icon={<InboxIcon aria-hidden />} title={t('emptyTitle')} description={t('emptyBody')} />
        )}
      </section>
    </div>
  );
}

function RunLabel({ run }: { readonly run: NonNullable<ReturnType<typeof useBulkRuns>['data']>[number] }) {
  const t = useTranslations('outbound.approvals');
  const offer = useTranslations('composer.offers');
  const format = useFormatter();
  return (
    <>
      <span className="block font-medium">{offer(run.offer)}</span>
      <span className="block text-xs text-muted-foreground">
        {format.dateTime(new Date(run.createdAt), { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
        {t(`runStatus.${run.status}`)}
      </span>
      <span className="block text-xs">
        {t('counts', { pending: run.pending, queued: run.queued, skipped: run.skipped })}
      </span>
    </>
  );
}

function StartRun({
  businessIds,
  onStarted,
}: {
  readonly businessIds: string[];
  readonly onStarted: (runId: string) => void;
}) {
  const t = useTranslations('outbound.approvals');
  const offerName = useTranslations('composer.offers');
  const actions = useBulkActions();
  const [offer, setOffer] = React.useState<Offer>('website_redesign');
  const [purpose, setPurpose] = React.useState<EmailPurpose>('first_touch');
  const [mode, setMode] = React.useState<'ai' | 'template'>('ai');
  const tooMany = businessIds.length > 100;
  const start = async () => {
    const toast = await getToast();
    try {
      const run = await actions.start.mutateAsync({
        businessIds: businessIds as never,
        offer,
        purpose,
        mode,
      });
      toast.success(t('started', { count: run.total }));
      onStarted(run.id);
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <h2 className="font-medium">{t('startTitle', { count: businessIds.length })}</h2>
      <p className="text-xs text-muted-foreground">{t('startHint')}</p>
      <div className="space-y-1">
        <Label htmlFor="bulk-offer">{t('offer')}</Label>
        <Select value={offer} onValueChange={(value) => setOffer(value as Offer)}>
          <SelectTrigger id="bulk-offer">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OFFERS.map((value) => (
              <SelectItem key={value} value={value}>
                {offerName(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="bulk-purpose">{t('purpose')}</Label>
          <Select value={purpose} onValueChange={(value) => setPurpose(value as EmailPurpose)}>
            <SelectTrigger id="bulk-purpose">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="first_touch">{t('purposes.first_touch')}</SelectItem>
              <SelectItem value="follow_up">{t('purposes.follow_up')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="bulk-mode">{t('mode')}</Label>
          <Select value={mode} onValueChange={(value) => setMode(value as 'ai' | 'template')}>
            <SelectTrigger id="bulk-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ai">{t('modes.ai')}</SelectItem>
              <SelectItem value="template">{t('modes.template')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {tooMany ? <p className="text-xs text-destructive">{t('tooMany')}</p> : null}
      <Button size="sm" disabled={tooMany || actions.start.isPending} onClick={() => void start()}>
        {t('start', { count: businessIds.length })}
      </Button>
    </div>
  );
}

function RunDetail({ id }: { readonly id: string }) {
  const t = useTranslations('outbound.approvals');
  const errorLabels = useErrorLabels();
  const detail = useBulkRun(id);
  const actions = useBulkActions();
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());
  const [confirmAll, setConfirmAll] = React.useState(false);
  const [editing, setEditing] = React.useState<Item | null>(null);
  React.useEffect(() => setChosen(new Set()), [id]);
  if (detail.isError)
    return (
      <ErrorState
        problem={toProblemLike(detail.error, t('loadError'))}
        labels={errorLabels}
        onRetry={() => void detail.refetch()}
      />
    );
  if (!detail.data) return <Skeleton className="h-96 w-full" />;
  const { run, items, skipped } = detail.data;
  const pending = items.filter((item) => item.status === 'pending_approval');
  const report = async (call: () => Promise<{ approved: number; rejected: number; refused: number }>) => {
    const toast = await getToast();
    try {
      const result = await call();
      setChosen(new Set());
      toast.success(
        t('result', { approved: result.approved, rejected: result.rejected, refused: result.refused }),
      );
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  const approve = (messageIds?: string[], expectedCount?: number) =>
    report(() =>
      actions.approve.mutateAsync({
        id: run.id,
        body: { ...(messageIds ? { messageIds } : {}), ...(expectedCount ? { expectedCount } : {}) },
      }),
    );
  const reject = (messageIds: string[]) =>
    report(() => actions.reject.mutateAsync({ id: run.id, messageIds }));
  const busy = actions.approve.isPending || actions.reject.isPending;
  const toggle = (itemId: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{t(`runStatus.${run.status}`)}</Badge>
        {run.autoApprove ? <Badge variant="secondary">{t('autoApprove')}</Badge> : null}
        <span className="text-sm text-muted-foreground">
          {t('progress', { done: run.drafted + run.skipped, total: run.total })}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={chosen.size === 0 || busy}
            onClick={() => void reject([...chosen])}
          >
            {t('rejectSelected', { count: chosen.size })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={chosen.size === 0 || busy}
            onClick={() => void approve([...chosen])}
          >
            {t('approveSelected', { count: chosen.size })}
          </Button>
          <Button size="sm" disabled={pending.length === 0 || busy} onClick={() => setConfirmAll(true)}>
            <CheckCheckIcon aria-hidden />
            {t('approveAll', { count: pending.length })}
          </Button>
        </div>
      </div>
      {items.length === 0 && run.status === 'drafting' ? <Skeleton className="h-40 w-full" /> : null}
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-start gap-3">
              {item.status === 'pending_approval' ? (
                <Checkbox
                  aria-label={t('select', { business: item.businessName })}
                  checked={chosen.has(item.id)}
                  onCheckedChange={() => toggle(item.id)}
                  className="mt-1"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{item.businessName}</span>
                  <span className="text-xs text-muted-foreground">{item.recipient}</span>
                  {item.compliance ? (
                    <Badge variant={item.compliance.decision === 'allowed' ? 'secondary' : 'outline'}>
                      {t(decisionKey(item.compliance.decision))}
                    </Badge>
                  ) : null}
                  <Badge variant="outline">{t(`itemStatus.${item.status}`)}</Badge>
                </div>
                <p className="mt-1 text-sm">{item.subject}</p>
                {item.blockedReasons.length > 0 ? (
                  <p className="text-xs text-destructive">{item.blockedReasons.join(', ')}</p>
                ) : null}
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {t('showPreview')}
                  </summary>
                  <iframe
                    title={t('previewOf', { business: item.businessName })}
                    sandbox=""
                    className="mt-2 h-80 w-full rounded-md border bg-white"
                    srcDoc={item.bodyHtml}
                  />
                </details>
              </div>
              {item.status === 'pending_approval' ? (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(item)}>
                    {t('edit')}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reject([item.id])}>
                    {t('reject')}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void approve([item.id])}>
                    {t('approve')}
                  </Button>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {skipped.length > 0 ? (
        <section>
          <h3 className="mb-2 text-sm font-medium">{t('skippedTitle', { count: skipped.length })}</h3>
          <ul className="space-y-1 text-sm">
            {skipped.map((skip) => (
              <li key={skip.businessId} className="rounded-md border px-3 py-2">
                <span className="font-medium">{skip.businessName || skip.businessId}</span>{' '}
                <Badge variant="outline">{t(decisionKey(skip.decision))}</Badge>
                {skip.reasons.length > 0 ? (
                  <span className="block text-xs text-muted-foreground">{skip.reasons.join(', ')}</span>
                ) : null}
                {skip.error ? (
                  <span className="block text-xs text-muted-foreground">{skip.error}</span>
                ) : null}
                {skip.alternatives.length > 0 ? (
                  <span className="block text-xs">
                    {t('alternatives', { list: skip.alternatives.join(', ') })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('confirmTitle', { count: pending.length })}</DialogTitle>
            <DialogDescription>{t('confirmBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAll(false)}>
              {t('cancel')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirmAll(false);
                void approve(undefined, pending.length);
              }}
            >
              {t('approveAll', { count: pending.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <EditItemDialog item={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function EditItemDialog({ item, onClose }: { readonly item: Item | null; readonly onClose: () => void }) {
  const t = useTranslations('outbound.approvals');
  const draft = useDraft(item?.draftId ?? null);
  const actions = useMessageActions();
  const [subject, setSubject] = React.useState('');
  const [body, setBody] = React.useState('');
  React.useEffect(() => {
    if (draft.data) {
      setSubject(draft.data.subject);
      setBody(draft.data.bodyMd);
    }
  }, [draft.data]);
  const save = async () => {
    if (!item) return;
    const toast = await getToast();
    try {
      await actions.edit.mutateAsync({ id: item.id, subject, bodyMd: body });
      toast.success(t('saved'));
      onClose();
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  return (
    <Dialog open={item !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('editTitle', { business: item?.businessName ?? '' })}</DialogTitle>
          <DialogDescription>{t('editHint')}</DialogDescription>
        </DialogHeader>
        {!draft.data ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="edit-subject">{t('subject')}</Label>
              <Input
                id="edit-subject"
                maxLength={150}
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-body">{t('body')}</Label>
              <Textarea
                id="edit-body"
                rows={12}
                className="font-mono text-sm"
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={!draft.data || actions.edit.isPending} onClick={() => void save()}>
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
