'use client';

import { type EffectivePolicy, OUTREACH_CHANNELS, PolicyDocumentSchema } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import { ErrorState } from '@bf/ui/components/error-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@bf/ui/components/sheet';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Textarea } from '@bf/ui/components/textarea';
import { ShieldCheckIcon, TriangleAlertIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useOverridePolicy, usePolicies, useReviewPolicy, useVersions } from './api.ts';
import { DecisionBadge } from './compliance-panel.tsx';
import { RuleViewer } from './rule-viewer.tsx';

// Settings → Compliance → Policies (BF-049): jurisdictions × channels with each policy's default decision and review
// status; a policy opens with its rules as sentences, sources, the legal review (and automatic sending for owners who
// may), a stricter-only override and its versions.

export function PoliciesMatrix() {
  const t = useTranslations('compliance.policies');
  const channelName = useTranslations('compliance.channels');
  const errorLabels = useErrorLabels();
  const policies = usePolicies();
  const [open, setOpen] = React.useState<EffectivePolicy | null>(null);
  if (policies.isError)
    return (
      <ErrorState
        problem={toProblemLike(policies.error, t('loadError'))}
        labels={errorLabels}
        onRetry={() => void policies.refetch()}
      />
    );
  if (!policies.data) return <Skeleton className="h-64 w-full" />;
  const jurisdictions = [...new Set(policies.data.map((policy) => policy.jurisdiction))];
  const cell = (jurisdiction: string, channel: string) =>
    policies.data.find((policy) => policy.jurisdiction === jurisdiction && policy.channel === channel);
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50">
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        {t('notLegalAdvice')}
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('caption')}</caption>
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-normal">
                {t('jurisdiction')}
              </th>
              {OUTREACH_CHANNELS.map((channel) => (
                <th key={channel} scope="col" className="px-3 py-2 text-left font-normal">
                  {channelName(channel)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {jurisdictions.map((jurisdiction) => (
              <tr key={jurisdiction} className="border-t">
                <th scope="row" className="px-3 py-2 text-left font-medium">
                  {jurisdiction === '*' ? t('anyOther') : jurisdiction}
                </th>
                {OUTREACH_CHANNELS.map((channel) => {
                  const policy = cell(jurisdiction, channel);
                  return (
                    <td key={channel} className="px-3 py-2">
                      {policy ? (
                        <button
                          type="button"
                          className="flex flex-col items-start gap-1 rounded p-1 text-left hover:bg-muted/60"
                          onClick={() => setOpen(policy)}
                          aria-label={t('open', { jurisdiction, channel: channelName(channel) })}
                        >
                          <DecisionBadge decision={(policy.override ?? policy.seed).policy.default} />
                          <span className="text-xs text-muted-foreground">
                            {policy.seed.needsLegalReview ? t('needsReview') : t('reviewed')}
                            {policy.autoSendEnabled ? ` · ${t('autoSend')}` : ''}
                            {policy.override ? ` · ${t('overridden')}` : ''}
                          </span>
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Sheet open={open !== null} onOpenChange={(value) => (value ? undefined : setOpen(null))}>
        <SheetContent side="right" className="w-full overflow-y-auto p-5 sm:max-w-2xl">
          <SheetTitle className="sr-only">{t('policy')}</SheetTitle>
          <SheetDescription className="sr-only">{t('policyHint')}</SheetDescription>
          {open ? <PolicyDetail policy={open} /> : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function PolicyDetail({ policy }: { readonly policy: EffectivePolicy }) {
  const t = useTranslations('compliance.policies');
  const channelName = useTranslations('compliance.channels');
  const format = useFormatter();
  const canManage = usePermission('compliance:manage');
  const mayAutoSend = usePermission('outreach:auto_send');
  const review = useReviewPolicy();
  const override = useOverridePolicy();
  const versions = useVersions(policy.jurisdiction, policy.channel, true);
  const [reviewer, setReviewer] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [confirmed, setConfirmed] = React.useState(false);
  const [autoSend, setAutoSend] = React.useState(policy.autoSendEnabled);
  const [draft, setDraft] = React.useState(() =>
    JSON.stringify((policy.override ?? policy.seed).policy, null, 2),
  );
  const effective = policy.override ?? policy.seed;
  const submitReview = async () => {
    const toast = await getToast();
    try {
      await review.mutateAsync({
        id: policy.seed.id,
        body: { reviewerName: reviewer, notes, confirmed: true, enableAutoSend: autoSend },
      });
      toast.success(t('reviewSaved'));
    } catch (error) {
      toast.error(toProblemLike(error, t('saveError')).title ?? t('saveError'));
    }
  };
  const submitOverride = async () => {
    const toast = await getToast();
    let parsed: ReturnType<typeof PolicyDocumentSchema.safeParse>;
    try {
      parsed = PolicyDocumentSchema.safeParse(JSON.parse(draft));
    } catch {
      toast.error(t('overrideInvalid'));
      return;
    }
    if (!parsed.success) {
      toast.error(t('overrideInvalid'));
      return;
    }
    try {
      const result = await override.mutateAsync({
        jurisdiction: policy.jurisdiction,
        channel: policy.channel,
        policy: parsed.data,
      });
      toast.success(
        t('overrideSaved', { stricter: result.impact.stricter, total: result.impact.combinations }),
      );
    } catch (error) {
      toast.error(toProblemLike(error, t('saveError')).title ?? t('saveError'));
    }
  };
  return (
    <div className="space-y-6 text-sm">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">
          {policy.jurisdiction === '*' ? t('anyOther') : policy.jurisdiction} · {channelName(policy.channel)}
        </h2>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {t('version', { version: effective.version, kind: t(`kind.${effective.kind}`) })}
          {policy.seed.reviewedAt ? (
            <Badge variant="secondary">
              <ShieldCheckIcon aria-hidden />
              {t('reviewedBy', {
                name: policy.seed.reviewedBy ?? '',
                when: format.dateTime(new Date(policy.seed.reviewedAt), { dateStyle: 'medium' }),
              })}
            </Badge>
          ) : (
            <Badge variant="outline">{t('needsReview')}</Badge>
          )}
        </p>
      </header>
      <section className="space-y-2">
        <h3 className="font-medium">{t('rules')}</h3>
        <RuleViewer policy={effective.policy} />
      </section>
      {policy.seed.sources.length > 0 ? (
        <section className="space-y-1">
          <h3 className="font-medium">{t('sources')}</h3>
          <ul className="list-disc pl-5">
            {policy.seed.sources.map((source) => (
              <li key={source.url}>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-lagoon hover:underline"
                >
                  {source.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {canManage ? (
        <section className="space-y-3 rounded-lg border p-3">
          <h3 className="font-medium">{t('reviewTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('reviewHint')}</p>
          <div className="space-y-1">
            <Label htmlFor="review-name">{t('reviewer')}</Label>
            <Input
              id="review-name"
              value={reviewer}
              maxLength={120}
              onChange={(event) => setReviewer(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="review-notes">{t('notes')}</Label>
            <Textarea
              id="review-notes"
              rows={3}
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <Label className="flex items-start gap-2 font-normal">
            <Checkbox checked={confirmed} onCheckedChange={(on) => setConfirmed(on === true)} />
            {t('confirm')}
          </Label>
          <Label className="flex items-start gap-2 font-normal">
            <Checkbox
              checked={autoSend}
              disabled={!mayAutoSend}
              onCheckedChange={(on) => setAutoSend(on === true)}
            />
            <span>
              {t('enableAutoSend')}
              {!mayAutoSend ? (
                <span className="block text-xs text-muted-foreground">{t('ownerOnly')}</span>
              ) : null}
            </span>
          </Label>
          <Button
            type="button"
            size="sm"
            disabled={!confirmed || reviewer.trim().length < 2 || review.isPending}
            onClick={() => void submitReview()}
          >
            {t('saveReview')}
          </Button>
        </section>
      ) : null}
      {canManage ? (
        <section className="space-y-2 rounded-lg border p-3">
          <h3 className="font-medium">{t('overrideTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('overrideHint')}</p>
          <Textarea
            aria-label={t('overrideTitle')}
            rows={12}
            className="font-mono text-xs"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={override.isPending}
            onClick={() => void submitOverride()}
          >
            {t('saveOverride')}
          </Button>
        </section>
      ) : null}
      <section className="space-y-1">
        <h3 className="font-medium">{t('versions')}</h3>
        {versions.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <ul className="space-y-0.5 text-xs">
            {(versions.data ?? []).map((version) => (
              <li key={version.id}>
                {t('version', { version: version.version, kind: t(`kind.${version.kind}`) })} ·{' '}
                {format.dateTime(new Date(version.createdAt), { dateStyle: 'medium' })}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
