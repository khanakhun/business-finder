'use client';

import { LEAD_STATUSES, type LeadStatus } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@bf/ui/components/sheet';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Textarea } from '@bf/ui/components/textarea';
import { MailIcon, MessageCircleIcon, PhoneIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useLead, useUpdateLead } from './api.ts';

// One lead (BF-048): what was sent, the consent and attribution, the spam signals (admins), and the actions — status,
// a note (audited), quick contact links, the business and its site.

const settable = LEAD_STATUSES.filter((status): status is Exclude<LeadStatus, 'spam'> => status !== 'spam');
/** Digits of a phone number for wa.me (no +, no spaces). */
const waDigits = (phone: string) => phone.replace(/\D/g, '');

export function LeadDrawer({
  leadId,
  onClose,
}: {
  readonly leadId: string | null;
  readonly onClose: () => void;
}) {
  const t = useTranslations('leads');
  return (
    <Sheet open={leadId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="right" className="w-full overflow-y-auto p-5 sm:max-w-lg">
        <SheetTitle className="sr-only">{t('lead')}</SheetTitle>
        <SheetDescription className="sr-only">{t('leadHint')}</SheetDescription>
        {leadId ? <LeadDetail id={leadId} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function LeadDetail({ id }: { readonly id: string }) {
  const t = useTranslations('leads');
  const format = useFormatter();
  const lead = useLead(id);
  const update = useUpdateLead(id);
  const canManage = usePermission('leads:manage');
  const [note, setNote] = React.useState('');
  if (lead.isLoading) return <Skeleton className="h-64 w-full" />;
  if (lead.isError || !lead.data) return <p className="text-sm text-destructive">{t('loadError')}</p>;
  const l = lead.data;
  const save = async (body: Parameters<typeof update.mutateAsync>[0]) => {
    const toast = await getToast();
    try {
      await update.mutateAsync(body);
      toast.success(t('saved'));
    } catch (error) {
      toast.error(toProblemLike(error, t('saveError')).title ?? t('saveError'));
    }
  };
  const row = (label: string, value: React.ReactNode) =>
    value ? (
      <>
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="break-words">{value}</dd>
      </>
    ) : null;
  return (
    <div className="space-y-5 text-sm">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{l.businessName}</h2>
        <p className="flex flex-wrap items-center gap-2">
          <Badge variant={l.kind === 'opt_out' ? 'destructive' : 'secondary'}>{t(`kind.${l.kind}`)}</Badge>
          <Badge variant="outline">{t(`status.${l.status}`)}</Badge>
          <span className="text-xs text-muted-foreground">
            {format.dateTime(new Date(l.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
          </span>
        </p>
      </header>
      <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1">
        {row(t('fields.name'), l.name)}
        {row(t('fields.email'), l.email)}
        {row(t('fields.phone'), l.phone)}
        {row(t('fields.whatsapp'), l.whatsapp)}
        {row(t('fields.preferredChannel'), l.preferredChannel ? t(`channel.${l.preferredChannel}`) : null)}
        {row(t('fields.preferredTime'), l.preferredTime)}
        {row(t('fields.source'), t(`source.${l.source}`))}
        {row(t('fields.locale'), l.locale.toUpperCase())}
      </dl>
      {l.message ? <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-3">{l.message}</p> : null}
      <div className="flex flex-wrap gap-2">
        {l.phone ? (
          <Button asChild size="sm" variant="outline">
            <a href={`tel:${l.phone}`}>
              <PhoneIcon aria-hidden />
              {t('call')}
            </a>
          </Button>
        ) : null}
        {l.whatsapp || l.phone ? (
          <Button asChild size="sm" variant="outline">
            <a
              href={`https://wa.me/${waDigits(l.whatsapp ?? l.phone ?? '')}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <MessageCircleIcon aria-hidden />
              WhatsApp
            </a>
          </Button>
        ) : null}
        {l.email ? (
          <Button asChild size="sm" variant="outline">
            <a href={`mailto:${l.email}`}>
              <MailIcon aria-hidden />
              {t('email')}
            </a>
          </Button>
        ) : null}
        <Button asChild size="sm" variant="ghost">
          <Link href={`/businesses/${l.businessId}`}>{t('openBusiness')}</Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link href={`/sites/${l.siteId}/edit`}>{t('openSite')}</Link>
        </Button>
      </div>
      <section className="space-y-1">
        <h3 className="font-medium">{t('consentTitle')}</h3>
        <p className="text-xs text-muted-foreground">
          {l.consent.checked ? t('consentGiven', { version: l.consent.textVersion }) : t('consentNone')}
        </p>
      </section>
      <section className="space-y-1">
        <h3 className="font-medium">{t('attributionTitle')}</h3>
        <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-xs">
          {row(t('attribution.campaign'), l.attribution.campaignRef)}
          {row(t('attribution.engine'), l.attribution.engine)}
          {row(t('attribution.version'), l.attribution.siteVersionId?.slice(0, 8))}
        </dl>
      </section>
      {l.spam ? (
        <section className="space-y-1">
          <h3 className="font-medium">{t('spamTitle')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('spamScore', { score: l.spam.score })} {l.spam.signals.join(', ')}
          </p>
        </section>
      ) : null}
      {canManage && l.status !== 'spam' ? (
        <section className="space-y-3 border-t pt-4">
          <div className="flex items-center gap-2">
            <Label htmlFor="lead-status">{t('changeStatus')}</Label>
            <Select
              value={l.status}
              onValueChange={(value) => void save({ status: value as (typeof settable)[number] })}
            >
              <SelectTrigger id="lead-status" size="sm" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {settable.map((status) => (
                  <SelectItem key={status} value={status}>
                    {t(`status.${status}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lead-note">{t('note')}</Label>
            <Textarea
              id="lead-note"
              rows={3}
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              disabled={note.trim() === '' || update.isPending}
              onClick={() => void save({ note: note.trim() }).then(() => setNote(''))}
            >
              {t('addNote')}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
