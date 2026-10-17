'use client';

import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@bf/ui/components/sheet';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@bf/ui/components/tabs';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { CompliancePanel } from '@/features/compliance/compliance-panel.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useMessageActions, useOutboundMessage } from '../outbound-api.ts';

/** One outbound message (BF-052): what was sent (HTML and text), its headers, both decisions and its timeline. */
export function MessageSheet({ id, onClose }: { readonly id: string | null; readonly onClose: () => void }) {
  const t = useTranslations('outbound.message');
  const status = useTranslations('outbound.status');
  const format = useFormatter();
  const message = useOutboundMessage(id);
  const actions = useMessageActions();
  const [when, setWhen] = React.useState('');
  const data = message.data;
  const reschedule = async () => {
    if (!data || !when) return;
    const toast = await getToast();
    try {
      await actions.reschedule.mutateAsync({ id: data.id, scheduledAt: new Date(when).toISOString() });
      toast.success(t('rescheduled'));
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  return (
    <Sheet open={id !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="right" className="w-full overflow-y-auto p-5 sm:max-w-3xl">
        <SheetTitle className="text-lg font-semibold">{data?.subject ?? t('title')}</SheetTitle>
        <SheetDescription className="sr-only">{t('description')}</SheetDescription>
        {!data ? (
          <Skeleton className="mt-4 h-96 w-full" />
        ) : (
          <div className="mt-4 space-y-4 text-sm">
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">{t('status')}</dt>
              <dd>
                <Badge variant="outline">{status(data.status)}</Badge>
              </dd>
              <dt className="text-muted-foreground">{t('to')}</dt>
              <dd>
                {data.businessName} · {data.recipientEmail || '—'}
              </dd>
              <dt className="text-muted-foreground">{t('from')}</dt>
              <dd>{data.mailboxEmail ?? '—'}</dd>
              <dt className="text-muted-foreground">{data.sentAt ? t('sentAt') : t('scheduledAt')}</dt>
              <dd>
                {format.dateTime(new Date(data.sentAt ?? data.scheduledAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </dd>
            </dl>
            {data.status === 'queued' ? (
              <div className="flex items-end gap-2">
                <div className="space-y-1">
                  <Label htmlFor="msg-when">{t('reschedule')}</Label>
                  <Input
                    id="msg-when"
                    type="datetime-local"
                    value={when}
                    onChange={(event) => setWhen(event.target.value)}
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!when || actions.reschedule.isPending}
                  onClick={() => void reschedule()}
                >
                  {t('move')}
                </Button>
              </div>
            ) : null}
            <Tabs defaultValue="preview">
              <TabsList>
                <TabsTrigger value="preview">{t('preview')}</TabsTrigger>
                <TabsTrigger value="text">{t('text')}</TabsTrigger>
                <TabsTrigger value="decisions">{t('decisions')}</TabsTrigger>
                <TabsTrigger value="headers">{t('headers')}</TabsTrigger>
              </TabsList>
              <TabsContent value="preview">
                <iframe
                  title={t('preview')}
                  sandbox=""
                  className="h-[28rem] w-full rounded-md border bg-white"
                  srcDoc={data.bodyHtml}
                />
              </TabsContent>
              <TabsContent value="text">
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-md border p-3 text-xs">
                  {data.bodyText}
                </pre>
              </TabsContent>
              <TabsContent value="decisions" className="space-y-4">
                <section>
                  <h3 className="mb-1 font-medium">{t('enqueueDecision')}</h3>
                  {data.enqueueDecision ? (
                    <CompliancePanel decision={data.enqueueDecision} />
                  ) : (
                    <p className="text-muted-foreground">{t('none')}</p>
                  )}
                </section>
                <section>
                  <h3 className="mb-1 font-medium">{t('sendDecision')}</h3>
                  {data.sendDecision ? (
                    <CompliancePanel decision={data.sendDecision} />
                  ) : (
                    <p className="text-muted-foreground">{t('notYet')}</p>
                  )}
                </section>
              </TabsContent>
              <TabsContent value="headers">
                <dl className="space-y-1 font-mono text-xs">
                  {Object.entries(data.headers).map(([name, value]) => (
                    <div key={name} className="break-all">
                      <dt className="inline font-semibold">{name}:</dt> <dd className="inline">{value}</dd>
                    </div>
                  ))}
                </dl>
              </TabsContent>
            </Tabs>
            <section>
              <h3 className="mb-1 font-medium">{t('timeline')}</h3>
              <ol className="space-y-1 text-xs">
                {data.timeline.map((entry) => (
                  <li key={`${entry.at}-${entry.status}`} className="flex gap-2">
                    <span className="text-muted-foreground">
                      {format.dateTime(new Date(entry.at), { dateStyle: 'short', timeStyle: 'medium' })}
                    </span>
                    <span>{status(entry.status)}</span>
                    {entry.detail ? <span className="text-muted-foreground">{entry.detail}</span> : null}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
