'use client';

import type { GoLiveReadiness } from '@bf/contracts';
import { Alert, AlertDescription, AlertTitle } from '@bf/ui/components/alert';
import { Button } from '@bf/ui/components/button';
import { ErrorState } from '@bf/ui/components/error-state';
import { Label } from '@bf/ui/components/label';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@bf/ui/components/tabs';
import { Textarea } from '@bf/ui/components/textarea';
import { ExternalLinkIcon } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useContactRouting, useDomains, useGoLiveActions, useLegalProfile, useReadiness } from './api.ts';
import { DomainStep } from './domain-step.tsx';
import { HandoverStep } from './handover-step.tsx';
import { LegalStep } from './legal-step.tsx';
import { type GoLiveStep, ReadinessChecklist } from './readiness-checklist.tsx';
import { RoutingStep } from './routing-step.tsx';

// The go-live wizard (BF-062): the readiness checklist, then each step that fixes a check (legal profile, contact
// routing, custom domains), then the live publication of the version the checks ran on, and the handover to the
// client (portal, approvals, change requests). The step is in the URL (`?step=`) so the checks' fix links land on it.

const STEPS: readonly GoLiveStep[] = ['readiness', 'legal', 'routing', 'domains', 'publish', 'handover'];
const isStep = (value: string | null): value is GoLiveStep => STEPS.includes(value as GoLiveStep);

function Loading() {
  return <Skeleton className="h-40 w-full" />;
}

export function GoLiveWizard({ siteId }: { readonly siteId: string }) {
  const t = useTranslations('goLive');
  const errorLabels = useErrorLabels();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const requested = params.get('step');
  const step: GoLiveStep = isStep(requested) ? requested : 'readiness';
  const readiness = useReadiness(siteId);
  const legal = useLegalProfile(siteId);
  const routing = useContactRouting(siteId);
  const domains = useDomains(siteId);
  const go = (next: GoLiveStep) => router.replace(`${pathname}?step=${next}`, { scroll: false });

  if (readiness.isError)
    return (
      <ErrorState
        problem={toProblemLike(readiness.error, t('loadError'))}
        labels={errorLabels}
        onRetry={() => void readiness.refetch()}
      />
    );
  return (
    <Tabs value={step} onValueChange={(value) => isStep(value) && go(value)} className="space-y-4">
      <TabsList className="flex-wrap">
        {STEPS.map((id, index) => (
          <TabsTrigger key={id} value={id}>
            {t('stepLabel', { n: index + 1, label: t(`steps.${id}`) })}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="readiness" className="space-y-3">
        {readiness.data ? (
          <>
            <ReadinessSummary readiness={readiness.data} />
            <ReadinessChecklist siteId={siteId} readiness={readiness.data} onStep={go} />
            <Button type="button" onClick={() => go('publish')}>
              {t('continue')}
            </Button>
          </>
        ) : (
          <Loading />
        )}
      </TabsContent>
      <TabsContent value="legal">
        {legal.isSuccess ? (
          <LegalStep key={legal.data?.version ?? 0} siteId={siteId} profile={legal.data} />
        ) : (
          <Loading />
        )}
      </TabsContent>
      <TabsContent value="routing">
        {routing.data ? (
          <RoutingStep
            key={`${routing.data.recipientEmail}:${routing.data.pendingEmail}`}
            siteId={siteId}
            routing={routing.data}
          />
        ) : (
          <Loading />
        )}
      </TabsContent>
      <TabsContent value="domains">
        {domains.data ? <DomainStep siteId={siteId} domains={domains.data} /> : <Loading />}
      </TabsContent>
      <TabsContent value="publish">
        {readiness.data ? (
          <PublishStep siteId={siteId} readiness={readiness.data} onStep={go} />
        ) : (
          <Loading />
        )}
      </TabsContent>
      <TabsContent value="handover">
        {readiness.data ? <HandoverStep siteId={siteId} versionId={readiness.data.versionId} /> : <Loading />}
      </TabsContent>
    </Tabs>
  );
}

function ReadinessSummary({ readiness }: { readonly readiness: GoLiveReadiness }) {
  const t = useTranslations('goLive');
  const failing = readiness.checks.filter((check) => check.status === 'fail').length;
  const warnings = readiness.checks.filter((check) => check.status === 'warn').length;
  return (
    <Alert variant={readiness.ready ? 'default' : 'destructive'}>
      <AlertTitle>{readiness.ready ? t('readyTitle') : t('notReadyTitle')}</AlertTitle>
      <AlertDescription>{t('summary', { failing, warnings })}</AlertDescription>
    </Alert>
  );
}

function PublishStep({
  siteId,
  readiness,
  onStep,
}: {
  readonly siteId: string;
  readonly readiness: GoLiveReadiness;
  readonly onStep: (step: GoLiveStep) => void;
}) {
  const t = useTranslations('goLive.publish');
  const actions = useGoLiveActions(siteId);
  const canOverride = usePermission('settings:manage');
  const [reason, setReason] = React.useState('');
  const [hostname, setHostname] = React.useState<string | null>(null);
  const blocking = readiness.checks.filter((check) => check.status === 'fail');
  // Only a missing deal may be overridden (with a reason, by someone who manages the workspace).
  const dealOnly = blocking.length > 0 && blocking.every((check) => check.id === 'deal');
  const allowed = readiness.ready || (dealOnly && canOverride && reason.trim().length >= 10);

  const publish = async () => {
    const toast = await getToast();
    try {
      const result = await actions.publishLive.mutateAsync({
        versionId: readiness.versionId,
        ...(readiness.ready ? {} : { overrideReason: reason.trim() }),
      });
      setHostname(result.hostname);
      toast.success(t('published', { hostname: result.hostname }));
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };

  if (hostname)
    return (
      <div className="space-y-2 text-sm" role="status">
        <p className="font-medium">{t('liveTitle')}</p>
        <a
          href={`https://${hostname}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-primary underline"
        >
          {hostname}
          <ExternalLinkIcon aria-hidden className="size-3" />
          <span className="sr-only">{t('opensNewTab')}</span>
        </a>
        <p className="text-muted-foreground">{t('liveHelp')}</p>
      </div>
    );
  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground">{t('help')}</p>
      {blocking.length > 0 && !dealOnly ? (
        <Alert variant="destructive">
          <AlertTitle>{t('blockedTitle')}</AlertTitle>
          <AlertDescription>
            {t('blocked', { count: blocking.length })}{' '}
            <Button type="button" variant="link" className="h-auto p-0" onClick={() => onStep('readiness')}>
              {t('review')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {dealOnly ? (
        canOverride ? (
          <div className="space-y-1">
            <Label htmlFor="golive-override">{t('overrideLabel')}</Label>
            <Textarea
              id="golive-override"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('overrideHelp')}</p>
          </div>
        ) : (
          <p className="text-destructive">{t('overrideNoPermission')}</p>
        )
      ) : null}
      <Button
        type="button"
        disabled={!allowed || actions.publishLive.isPending}
        onClick={() => void publish()}
      >
        {t('button')}
      </Button>
    </div>
  );
}
