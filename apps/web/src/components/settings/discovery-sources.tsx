'use client';

import type { DiscoveryProviderList, OrgSettings, ProviderId, ScraperStatus } from '@bf/contracts';
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
import { ErrorState } from '@bf/ui/components/error-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Switch } from '@bf/ui/components/switch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { useSession } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { moveProvider } from './discovery-order.ts';
import { SettingsSection } from './section.tsx';
import { useWorkspaceSettings } from './workspace-settings.tsx';

type DiscoveryPatch = Partial<OrgSettings['discovery']>;

/** Settings → Integrations → Discovery sources (BF-019): enable and order providers, Overture release, scraper. */
export function DiscoverySources() {
  const t = useTranslations('integrations.discovery');
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  const settings = useWorkspaceSettings(true);
  const providers = useQuery({
    queryKey: queryKeys.discovery.providers(),
    queryFn: async () => (await apiClient().GET('/v1/discovery/providers')).data as DiscoveryProviderList,
  });
  const save = useMutation({
    mutationFn: async (discovery: DiscoveryPatch) =>
      (await apiClient().PATCH('/v1/workspace/settings', { body: { discovery } })).data as OrgSettings,
    onSuccess: async (saved) => {
      client.setQueryData(queryKeys.workspace.settings(), saved);
      await client.invalidateQueries({ queryKey: queryKeys.discovery.providers() });
      (await getToast()).success(t('saved'));
    },
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });

  const labels = useErrorLabels();
  const errorTitle = useTranslations('errors')('pageTitle');
  const failed = settings.error ?? providers.error;
  if (failed) {
    return (
      <SettingsSection id="discovery-sources" title={t('title')} description={t('description')}>
        <ErrorState
          problem={toProblemLike(failed, errorTitle)}
          labels={labels}
          onRetry={() => void Promise.all([settings.refetch(), providers.refetch()])}
        />
      </SettingsSection>
    );
  }
  const discovery = settings.data?.discovery;
  const items = providers.data?.items;
  return (
    <SettingsSection id="discovery-sources" title={t('title')} description={t('description')}>
      {!discovery || !items ? (
        <Skeleton className="h-48" />
      ) : (
        <div className="grid gap-6">
          <ol className="grid gap-3" aria-label={t('orderLabel')}>
            {items.map((provider, index) => {
              const enabled = !discovery.disabledProviders.includes(provider.id);
              const id = `discovery-${provider.id}`;
              const move = (delta: number) =>
                save.mutate({
                  providerOrder: moveProvider(
                    items.map((p) => p.id),
                    index,
                    delta,
                  ),
                });
              return (
                <li
                  key={provider.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="grid gap-1">
                    <Label htmlFor={id}>{provider.label}</Label>
                    <p id={`${id}-licence`} className="text-sm text-muted-foreground">
                      {provider.licensing.attributionText ?? t('noAttribution')}
                    </p>
                    <Badge variant={provider.status === 'ready' ? 'secondary' : 'outline'} className="w-fit">
                      {t(`status.${provider.status}`)}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('moveUp', { provider: provider.label })}
                      disabled={index === 0 || save.isPending}
                      onClick={() => move(-1)}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('moveDown', { provider: provider.label })}
                      disabled={index === items.length - 1 || save.isPending}
                      onClick={() => move(1)}
                    >
                      ↓
                    </Button>
                    <Switch
                      id={id}
                      aria-describedby={`${id}-licence`}
                      checked={enabled}
                      disabled={save.isPending}
                      onCheckedChange={(on) =>
                        save.mutate({
                          disabledProviders: on
                            ? discovery.disabledProviders.filter((p) => p !== provider.id)
                            : [...discovery.disabledProviders, provider.id as ProviderId],
                        })
                      }
                    />
                  </div>
                </li>
              );
            })}
          </ol>
          <GoogleDetailLevel
            value={discovery.googleFieldTier}
            pending={save.isPending}
            onChange={(googleFieldTier) => save.mutate({ googleFieldTier })}
          />
          <OvertureRelease
            value={discovery.overtureRelease}
            pending={save.isPending}
            onSave={(overtureRelease) => save.mutate({ overtureRelease })}
          />
          <p className="text-sm text-muted-foreground">{t('huggingfaceHint')}</p>
          <ScraperGate />
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * How much Google Places returns per business (and so its price per call): Pro has names, addresses and categories;
 * Enterprise adds the website, phone, rating and opening hours — what the scoring and the generated sites rely on.
 * `essentials` is served as Pro (discovery needs names), so it is not offered.
 */
function GoogleDetailLevel({
  value,
  pending,
  onChange,
}: {
  readonly value: OrgSettings['discovery']['googleFieldTier'];
  readonly pending: boolean;
  readonly onChange: (tier: 'pro' | 'enterprise') => void;
}) {
  const t = useTranslations('integrations.discovery.googleTier');
  const current = value === 'enterprise' ? 'enterprise' : 'pro';
  return (
    <fieldset className="grid gap-2" disabled={pending}>
      <legend className="mb-1 text-sm font-medium">{t('title')}</legend>
      <p className="text-sm text-muted-foreground">{t('hint')}</p>
      {(['pro', 'enterprise'] as const).map((tier) => (
        <label
          key={tier}
          htmlFor={`google-tier-${tier}`}
          className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary"
        >
          <input
            id={`google-tier-${tier}`}
            type="radio"
            name="google-tier"
            className="mt-1"
            checked={current === tier}
            onChange={() => onChange(tier)}
          />
          <span className="grid gap-0.5">
            <span className="text-sm font-medium">{t(`${tier}.label`)}</span>
            <span className="text-sm text-muted-foreground">{t(`${tier}.description`)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function OvertureRelease({
  value,
  pending,
  onSave,
}: {
  readonly value: string | null;
  readonly pending: boolean;
  readonly onSave: (release: string | null) => void;
}) {
  const t = useTranslations('integrations.discovery');
  const [pinned, setPinned] = React.useState(value ?? '');
  React.useEffect(() => setPinned(value ?? ''), [value]);
  const valid = /^\d{4}-\d{2}-\d{2}\.\d{1,3}$/.test(pinned);
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(pinned.trim() ? pinned.trim() : null);
      }}
    >
      <Label htmlFor="overture-release">{t('overtureRelease')}</Label>
      <p id="overture-release-hint" className="text-sm text-muted-foreground">
        {t('overtureReleaseHint')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          id="overture-release"
          aria-describedby="overture-release-hint"
          className="max-w-48"
          placeholder={t('latest')}
          value={pinned}
          aria-invalid={pinned !== '' && !valid}
          onChange={(event) => setPinned(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={pending || (pinned !== '' && !valid)}>
          {t('save')}
        </Button>
      </div>
    </form>
  );
}

function ScraperGate() {
  const t = useTranslations('integrations.discovery.scraper');
  const locale = useLocale() as 'en' | 'fr';
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  const owner = useSession().role === 'owner';
  const [open, setOpen] = React.useState(false);
  const [accepted, setAccepted] = React.useState(false);
  // Consent is given afresh each time: closing the dialog clears the box.
  const close = () => {
    setOpen(false);
    setAccepted(false);
  };
  const status = useQuery({
    queryKey: queryKeys.discovery.scraper(),
    queryFn: async () => (await apiClient().GET('/v1/discovery/scraper')).data as ScraperStatus,
  });
  const update = useMutation({
    mutationFn: async (acknowledge: boolean) => {
      const api = apiClient();
      const result = acknowledge
        ? await api.POST('/v1/discovery/scraper/acknowledgement', {
            body: { warningVersion: status.data?.warningVersion ?? 0 },
          })
        : await api.DELETE('/v1/discovery/scraper/acknowledgement');
      return result.data as ScraperStatus;
    },
    onSuccess: async (saved) => {
      client.setQueryData(queryKeys.discovery.scraper(), saved);
      await client.invalidateQueries({ queryKey: queryKeys.discovery.providers() });
      close();
    },
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });
  const data = status.data;
  if (status.isPending) return <Skeleton className="h-16" />;
  if (status.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
        {t('loadFailed')}
        <Button variant="outline" size="sm" onClick={() => void status.refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  // Hidden unless the deployment ships the scraper.
  if (!data?.deployed) return null;
  return (
    <section
      aria-labelledby="scraper-title"
      className="grid gap-2 rounded-md border border-destructive/40 p-3"
    >
      <h3 id="scraper-title" className="font-medium">
        {t('title')}
      </h3>
      <p className="text-sm">{data.warning[locale]}</p>
      <p className="text-sm text-muted-foreground">
        {data.acknowledgement
          ? t('acknowledged', {
              date: format.dateTime(new Date(data.acknowledgement.acknowledgedAt), { dateStyle: 'medium' }),
            })
          : t('notAcknowledged')}{' '}
        {data.flagEnabled ? '' : t('flagOff')}
      </p>
      {owner ? (
        data.acknowledgement ? (
          <Button
            variant="outline"
            className="w-fit"
            disabled={update.isPending}
            onClick={() => update.mutate(false)}
          >
            {t('revoke')}
          </Button>
        ) : (
          <Button variant="destructive" className="w-fit" onClick={() => setOpen(true)}>
            {t('acknowledge')}
          </Button>
        )
      ) : (
        <p className="text-sm text-muted-foreground">{t('ownerOnly')}</p>
      )}
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('dialogTitle')}</DialogTitle>
            <DialogDescription>{data.warning[locale]}</DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2">
            <Checkbox
              id="scraper-accept"
              checked={accepted}
              onCheckedChange={(v) => setAccepted(v === true)}
            />
            <Label htmlFor="scraper-accept" className="leading-snug">
              {t('accept')}
            </Label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={!accepted || update.isPending}
              onClick={() => update.mutate(true)}
            >
              {t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
