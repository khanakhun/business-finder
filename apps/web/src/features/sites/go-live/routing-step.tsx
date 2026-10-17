'use client';

import type { SiteContactRouting } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { getToast } from '@/lib/toast.tsx';
import { useGoLiveActions } from './api.ts';

// Contact routing (BF-062): where the live site's contact form is delivered. A new address gets a confirmation link
// and receives nothing until it is confirmed.

export function RoutingStep({
  siteId,
  routing,
}: {
  readonly siteId: string;
  readonly routing: SiteContactRouting;
}) {
  const t = useTranslations('goLive.routing');
  const format = useFormatter();
  const actions = useGoLiveActions(siteId);
  const [email, setEmail] = React.useState(routing.pendingEmail ?? routing.recipientEmail ?? '');
  const [cc, setCc] = React.useState(routing.cc ?? '');

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const toast = await getToast();
    try {
      await actions.setRouting.mutateAsync({ email: email.trim(), cc: cc.trim() ? cc.trim() : null });
      toast.success(t('sent', { email: email.trim() }));
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };

  return (
    <form className="space-y-4" onSubmit={save}>
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      <div className="space-y-1 text-sm">
        {routing.recipientEmail && routing.verifiedAt ? (
          <p className="flex flex-wrap items-center gap-2">
            {t('current', { email: routing.recipientEmail })}
            <Badge variant="secondary">
              {t('verified', {
                date: format.dateTime(new Date(routing.verifiedAt), { dateStyle: 'medium' }),
              })}
            </Badge>
          </p>
        ) : (
          <p className="text-muted-foreground">{t('none')}</p>
        )}
        {routing.pendingEmail ? (
          <p role="status" className="text-amber-700 dark:text-amber-400">
            {t('pending', { email: routing.pendingEmail })}
          </p>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="routing-email">{t('email')} *</Label>
          <Input
            id="routing-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="routing-cc">{t('cc')}</Label>
          <Input id="routing-cc" type="email" value={cc} onChange={(event) => setCc(event.target.value)} />
        </div>
      </div>
      <Button type="submit" disabled={actions.setRouting.isPending || !email.trim()}>
        {t('send')}
      </Button>
    </form>
  );
}
