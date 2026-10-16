'use client';

import type { EnrichmentRun, EnrichmentStepId, WebsiteSnapshot } from '@bf/contracts';
import { Alert, AlertDescription, AlertTitle } from '@bf/ui/components/alert';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@bf/ui/components/card';
import { Checkbox } from '@bf/ui/components/checkbox';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Label } from '@bf/ui/components/label';
import { Skeleton } from '@bf/ui/components/skeleton';
import { GlobeIcon, HandIcon, RefreshCwIcon, SparklesIcon, SquareIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import type { BusinessTabProps } from '@/features/business/tabs/registry.ts';
import { safeWebUrl } from '@/features/search/safe-url.ts';
import { publicEnv } from '@/lib/public-env.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useBusinessEnrichment, useCancelRun, useEnrich, useWebsite } from './api.ts';
import { AuditPanel } from './audit-panel.tsx';

const OPEN = new Set(['queued', 'running']);

function ExternalLink({ href, children }: { readonly href: string; readonly children: React.ReactNode }) {
  const url = safeWebUrl(href);
  if (!url) return <span className="break-all">{children}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all text-lagoon underline underline-offset-2 hover:decoration-2"
    >
      {children}
    </a>
  );
}

function Chips({ items, empty }: { readonly items: readonly string[]; readonly empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li key={item}>
          <Badge variant="outline">{item}</Badge>
        </li>
      ))}
    </ul>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

/** Where the latest run stands, step by step, with Enrich now / Re-run and the steps to run. */
function EnrichPanel({ businessId }: { readonly businessId: string }) {
  const t = useTranslations('enrichment');
  const format = useFormatter();
  const canWrite = usePermission('business:write');
  const enrichment = useBusinessEnrichment(businessId);
  const enrich = useEnrich(businessId);
  const cancel = useCancelRun(businessId);
  const registered = enrichment.data?.steps.filter((s) => s.registered) ?? [];
  const [selected, setSelected] = React.useState<ReadonlySet<EnrichmentStepId> | null>(null);
  const chosen = selected ?? new Set(registered.map((s) => s.step));
  const run: EnrichmentRun | null = enrichment.data?.latestRun ?? null;
  const open = run !== null && OPEN.has(run.status);
  const id = React.useId();

  const start = async (force: boolean) => {
    try {
      // One key per click: a retried request joins the run it already started.
      await enrich.mutateAsync({ steps: [...chosen], force, key: `enrich-${crypto.randomUUID()}` });
      (await getToast()).success(t('started'));
    } catch {
      (await getToast()).error(t('startFailed'));
    }
  };

  if (enrichment.isLoading) return <Skeleton className="h-28 w-full" />;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="text-base">{t('title')}</CardTitle>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {run
              ? t('runStatus', {
                  status: t(`runStatuses.${run.status}` as never),
                  when: format.relativeTime(new Date(run.finishedAt ?? run.createdAt)),
                })
              : t('neverRun')}
          </p>
        </div>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            {open && run ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(run.id)}
              >
                <SquareIcon aria-hidden />
                {t('cancel')}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  disabled={enrich.isPending || chosen.size === 0}
                  onClick={() => void start(false)}
                >
                  <SparklesIcon aria-hidden />
                  {t('enrichNow')}
                </Button>
                {run ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={enrich.isPending || chosen.size === 0}
                    onClick={() => void start(true)}
                  >
                    <RefreshCwIcon aria-hidden />
                    {t('rerun')}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {canWrite && !open ? (
          <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
            <legend className="sr-only">{t('stepsLegend')}</legend>
            {(enrichment.data?.steps ?? []).map((step) => (
              <div key={step.step} className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-${step.step}`}
                  checked={step.registered && chosen.has(step.step)}
                  disabled={!step.registered}
                  onCheckedChange={(checked) => {
                    const next = new Set(chosen);
                    if (checked) next.add(step.step);
                    else next.delete(step.step);
                    setSelected(next);
                  }}
                />
                <Label
                  htmlFor={`${id}-${step.step}`}
                  className={step.registered ? undefined : 'text-muted-foreground'}
                >
                  {t(`steps.${step.step}` as never)}
                  {step.registered ? (step.fresh ? ` · ${t('fresh')}` : '') : ` · ${t('comingSoon')}`}
                </Label>
              </div>
            ))}
          </fieldset>
        ) : null}
        {run ? (
          <ol className="divide-y rounded-md border text-sm">
            {run.steps.map((step) => (
              <li key={step.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>{t(`steps.${step.step}` as never)}</span>
                <span className="text-muted-foreground">
                  {t(`stepStatuses.${step.status}` as never)}
                  {step.skipReason ? ` — ${t(`skipReasons.${step.skipReason}` as never)}` : ''}
                  {step.error ? ` — ${step.error}` : ''}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Screenshot({
  businessId,
  kind,
  alt,
}: {
  readonly businessId: string;
  readonly kind: 'desktop' | 'mobile';
  readonly alt: string;
}) {
  const src = `${publicEnv().apiUrl}/v1/businesses/${businessId}/website/screenshots/${kind}`;
  return (
    // Served by the API with the session cookie; an <img> keeps the untrusted render inert.
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className={kind === 'mobile' ? 'max-h-96 w-auto rounded-md border' : 'w-full rounded-md border'}
    />
  );
}

function SnapshotView({
  businessId,
  snapshot,
}: {
  readonly businessId: string;
  readonly snapshot: WebsiteSnapshot;
}) {
  const t = useTranslations('enrichment');
  const format = useFormatter();
  const yes = t('yes');
  const no = t('no');
  const unknown = t('unknown');
  const bool = (value: boolean | null) => (value === null ? unknown : value ? yes : no);
  const tools = (providers: readonly { name: string }[]) => providers.map((p) => p.name);
  const analytics = [
    ...(snapshot.analytics.ga4 ? ['GA4'] : []),
    ...(snapshot.analytics.gtm ? ['Google Tag Manager'] : []),
    ...(snapshot.analytics.metaPixel ? ['Meta Pixel'] : []),
    ...(snapshot.analytics.tiktokPixel ? ['TikTok Pixel'] : []),
    ...snapshot.analytics.others,
  ];
  return (
    <div className="space-y-4">
      {snapshot.noSolicitationMarker ? (
        <Alert variant="destructive">
          <HandIcon aria-hidden />
          <AlertTitle>{t('noSolicitation.title')}</AlertTitle>
          <AlertDescription>
            <p>{t('noSolicitation.description')}</p>
            {snapshot.noSolicitationMarker.snippet ? (
              <q className="italic">{snapshot.noSolicitationMarker.snippet}</q>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('site.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <Fact label={t('site.reachability')}>
                {t(`reachability.${snapshot.reachability}` as never)}
              </Fact>
              <Fact label={t('site.finalUrl')}>
                {snapshot.finalUrl ? (
                  <ExternalLink href={snapshot.finalUrl}>{snapshot.finalUrl}</ExternalLink>
                ) : (
                  unknown
                )}
              </Fact>
              <Fact label={t('site.crawled')}>{format.relativeTime(new Date(snapshot.fetchedAt))}</Fact>
              <Fact label={t('site.https')}>{bool(snapshot.security.https)}</Fact>
              <Fact label={t('site.tls')}>{bool(snapshot.tls.valid)}</Fact>
              <Fact label={t('site.mixedContent')}>{bool(snapshot.security.mixedContent)}</Fact>
              <Fact label={t('site.languages')}>
                {[...new Set([...snapshot.languages.declared, ...snapshot.languages.detected])].join(', ') ||
                  unknown}
              </Fact>
              <Fact label={t('site.copyright')}>{snapshot.freshness.copyrightYear ?? unknown}</Fact>
              <Fact label={t('site.viewport')}>{bool(snapshot.mobile.hasViewportMeta)}</Fact>
              <Fact label={t('site.smallText')}>{bool(snapshot.mobile.fontSizeIssues)}</Fact>
              <Fact label={t('site.weight')}>
                {snapshot.performanceHints.pageWeightKb === null
                  ? unknown
                  : t('site.kb', { kb: snapshot.performanceHints.pageWeightKb })}
              </Fact>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('contacts.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {snapshot.contacts.emails.length + snapshot.contacts.phones.length === 0 ? (
              <p className="text-muted-foreground">{t('contacts.none')}</p>
            ) : (
              <ul className="space-y-1.5">
                {snapshot.contacts.emails.map((email) => (
                  <li key={email.email}>
                    <span className="font-medium">{email.email}</span>{' '}
                    <span className="text-muted-foreground">
                      — <ExternalLink href={email.pageUrl}>{t('contacts.onPage')}</ExternalLink>
                    </span>
                  </li>
                ))}
                {snapshot.contacts.phones.map((phone) => (
                  <li key={phone.e164}>
                    <span className="font-medium">{phone.e164}</span>
                    {phone.isWhatsApp ? (
                      <Badge variant="secondary" className="ml-2">
                        WhatsApp
                      </Badge>
                    ) : null}{' '}
                    <span className="text-muted-foreground">
                      — <ExternalLink href={phone.pageUrl}>{t('contacts.onPage')}</ExternalLink>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <h3 className="mb-1.5 font-medium">{t('contacts.socials')}</h3>
              {snapshot.socials.length === 0 ? (
                <p className="text-muted-foreground">{t('none')}</p>
              ) : (
                <ul className="space-y-1">
                  {snapshot.socials.map((social) => (
                    <li key={social.url}>
                      <ExternalLink href={social.url}>{social.handle ?? social.url}</ExternalLink>{' '}
                      <span className="text-muted-foreground">({social.network})</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">{t('tools.title')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(
              [
                ['booking', tools(snapshot.booking.providers)],
                ['ordering', tools(snapshot.ordering.providers)],
                ['chat', tools(snapshot.chat.providers)],
                ['analytics', analytics],
                [
                  'tech',
                  snapshot.tech.map((tech) => (tech.version ? `${tech.name} ${tech.version}` : tech.name)),
                ],
              ] as const
            ).map(([key, items]) => (
              <div key={key}>
                <h3 className="mb-1.5 text-sm font-medium">{t(`tools.${key}` as never)}</h3>
                <Chips items={items} empty={t('none')} />
              </div>
            ))}
          </CardContent>
        </Card>
        {snapshot.screenshots.desktop || snapshot.screenshots.mobile ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">{t('screenshots.title')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 md:flex-row md:items-start">
              {snapshot.screenshots.desktop ? (
                <figure className="min-w-0 flex-1 space-y-1.5">
                  <Screenshot businessId={businessId} kind="desktop" alt={t('screenshots.desktop')} />
                  <figcaption className="text-xs text-muted-foreground">
                    {t('screenshots.desktop')}
                  </figcaption>
                </figure>
              ) : null}
              {snapshot.screenshots.mobile ? (
                <figure className="space-y-1.5">
                  <Screenshot businessId={businessId} kind="mobile" alt={t('screenshots.mobile')} />
                  <figcaption className="text-xs text-muted-foreground">{t('screenshots.mobile')}</figcaption>
                </figure>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

/** The business website as the last crawl saw it, and its enrichment runs (BF-027). */
export function WebsiteTab({ business }: BusinessTabProps) {
  const t = useTranslations('enrichment');
  const errorLabels = useErrorLabels();
  const website = useWebsite(business.id);
  return (
    <div className="space-y-6">
      <EnrichPanel businessId={business.id} />
      <AuditPanel businessId={business.id} hasWebsite={Boolean(business.websiteUrl)} />
      {website.isError ? (
        <ErrorState
          problem={toProblemLike(website.error, t('error'))}
          labels={errorLabels}
          onRetry={() => void website.refetch()}
        />
      ) : website.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : website.data ? (
        <SnapshotView businessId={business.id} snapshot={website.data} />
      ) : (
        <EmptyState
          icon={<GlobeIcon aria-hidden />}
          title={t('emptyTitle')}
          description={business.websiteUrl ? t('empty') : t('noWebsite')}
        />
      )}
    </div>
  );
}
