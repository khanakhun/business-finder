'use client';

import type { components } from '@bf/api-client';
import {
  LOCALES,
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  type Locale,
  type OrgSettings,
  type PostalAddress,
} from '@bf/contracts';
import { Alert, AlertDescription, AlertTitle } from '@bf/ui/components/alert';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import { Combobox } from '@bf/ui/components/combobox';
import { ErrorState } from '@bf/ui/components/error-state';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import { Field, FormError, useErrorMessage } from '@/components/auth/fields.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { countryOptions, timeZoneOptions } from '@/lib/countries.ts';
import { fetchLogo, uploadLogo } from '@/lib/logo.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { Forbidden } from './forbidden.tsx';
import { SettingsSection } from './section.tsx';

export function useWorkspaceSettings(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.workspace.settings(),
    queryFn: async () => (await apiClient().GET('/v1/workspace/settings')).data as OrgSettings,
    enabled,
  });
}

export function WorkspaceSettings() {
  const t = useTranslations();
  const canManage = usePermission('settings:manage');
  const labels = useErrorLabels();
  const query = useWorkspaceSettings(canManage);
  if (!canManage) return <Forbidden />;
  if (query.isError) {
    return (
      <ErrorState
        problem={toProblemLike(query.error, t('errors.pageTitle'))}
        labels={labels}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <Skeleton className="h-96 max-w-3xl" />;
  return (
    <div className="grid gap-6">
      <Readiness settings={query.data} />
      {/* Remount with fresh values after a save (the form keeps its own draft state). */}
      <SettingsForm key={query.data.updatedAt ?? 'new'} settings={query.data} />
      <LogoSection hasLogo={query.data.hasLogo} />
    </div>
  );
}

function Readiness({ settings }: { readonly settings: OrgSettings }) {
  const t = useTranslations('workspaceSettings');
  if (settings.outreachReadiness.ready) return null;
  const missing = settings.outreachReadiness.missing.map((item) => t(`missing.${item}`)).join(', ');
  return (
    <Alert className="max-w-3xl">
      <AlertTitle>{t('readinessTitle')}</AlertTitle>
      <AlertDescription>{t('readinessBody', { missing })}</AlertDescription>
    </Alert>
  );
}

type SettingsPatch = components['schemas']['UpdateOrgSettingsRequest'];

const EMPTY_ADDRESS = { line1: '', line2: '', city: '', postalCode: '', region: '', countryCode: '' };

const addressDraft = (address: PostalAddress | null): typeof EMPTY_ADDRESS => ({
  line1: address?.line1 ?? '',
  line2: address?.line2 ?? '',
  city: address?.city ?? '',
  postalCode: address?.postalCode ?? '',
  region: address?.region ?? '',
  countryCode: address?.countryCode ?? '',
});

function SettingsForm({ settings }: { readonly settings: OrgSettings }) {
  const t = useTranslations('workspaceSettings');
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  const [agencyName, setAgencyName] = React.useState(settings.agencyName ?? '');
  const [legalName, setLegalName] = React.useState(settings.legalName ?? '');
  const [websiteUrl, setWebsiteUrl] = React.useState(settings.websiteUrl ?? '');
  const [address, setAddress] = React.useState(() => addressDraft(settings.postalAddress));
  const [locales, setLocales] = React.useState<Locale[]>(settings.locales);
  const [primaryLocale, setPrimaryLocale] = React.useState<Locale>(settings.primaryLocale);
  const [timezone, setTimezone] = React.useState(settings.timezone);
  const [defaultCountry, setDefaultCountry] = React.useState<string | undefined>(
    settings.defaultCountryCode ?? undefined,
  );
  const [error, setError] = React.useState<string | null>(null);
  const countries = React.useMemo(() => countryOptions(locale), [locale]);
  const zones = React.useMemo(() => timeZoneOptions(), []);
  const languageNames = React.useMemo(() => new Intl.DisplayNames([locale], { type: 'language' }), [locale]);

  const save = useMutation({
    mutationFn: async (body: SettingsPatch) =>
      (await apiClient().PATCH('/v1/workspace/settings', { body })).data,
    onSuccess: async (saved) => {
      client.setQueryData(queryKeys.workspace.settings(), saved);
      (await getToast()).success(t('saved'));
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const postalAddress = toAddress(address);
    if (postalAddress === 'incomplete') {
      setError(t('addressIncomplete'));
      return;
    }
    save.mutate({
      agencyName: agencyName.trim() || null,
      legalName: legalName.trim() || null,
      websiteUrl: websiteUrl.trim() || null,
      postalAddress,
      locales,
      primaryLocale: locales.includes(primaryLocale) ? primaryLocale : (locales[0] as Locale),
      timezone,
      defaultCountryCode: defaultCountry ?? null,
    });
  };

  const setLine = (key: keyof typeof EMPTY_ADDRESS) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setAddress((current) => ({ ...current, [key]: event.target.value }));

  return (
    <form onSubmit={onSubmit} className="grid max-w-3xl gap-6" noValidate>
      <FormError message={error} />
      <SettingsSection id="identity" title={t('identity')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('agencyName')} value={agencyName} onChange={(e) => setAgencyName(e.target.value)} />
          <Field
            label={t('legalName')}
            hint={t('legalNameHint')}
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
          />
          <Field
            label={t('websiteUrl')}
            type="url"
            inputMode="url"
            placeholder="https://"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
          />
        </div>
      </SettingsSection>

      <SettingsSection id="address" title={t('address')} description={t('addressHint')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('line1')}
            autoComplete="address-line1"
            value={address.line1}
            onChange={setLine('line1')}
          />
          <Field
            label={t('line2')}
            autoComplete="address-line2"
            value={address.line2}
            onChange={setLine('line2')}
          />
          <Field
            label={t('city')}
            autoComplete="address-level2"
            value={address.city}
            onChange={setLine('city')}
          />
          <Field
            label={t('postalCode')}
            autoComplete="postal-code"
            value={address.postalCode}
            onChange={setLine('postalCode')}
          />
          <Field
            label={t('region')}
            autoComplete="address-level1"
            value={address.region}
            onChange={setLine('region')}
          />
          <div className="grid gap-1.5">
            <Label htmlFor="country">{t('country')}</Label>
            <Combobox
              id="country"
              options={countries}
              value={address.countryCode || undefined}
              onChange={(value) => setAddress((current) => ({ ...current, countryCode: value ?? '' }))}
              placeholder={t('countryPlaceholder')}
              searchPlaceholder={t('countrySearch')}
              emptyText={t('noCountry')}
            />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection id="languages" title={t('languages')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t('locales')}</legend>
            {LOCALES.map((code) => (
              <div key={code} className="flex items-center gap-2">
                <Checkbox
                  id={`locale-${code}`}
                  checked={locales.includes(code)}
                  // At least one language stays selected.
                  disabled={locales.length === 1 && locales.includes(code)}
                  onCheckedChange={(checked) => {
                    const next = checked ? [...locales, code] : locales.filter((value) => value !== code);
                    setLocales(next);
                    // Keep the primary language among the selected ones.
                    if (!next.includes(primaryLocale) && next[0]) setPrimaryLocale(next[0]);
                  }}
                />
                <Label htmlFor={`locale-${code}`} className="font-normal">
                  {languageNames.of(code) ?? code}
                </Label>
              </div>
            ))}
          </fieldset>
          <div className="grid content-start gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="primary-locale">{t('primaryLocale')}</Label>
              <Select value={primaryLocale} onValueChange={(value) => setPrimaryLocale(value as Locale)}>
                <SelectTrigger id="primary-locale">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {locales.map((code) => (
                    <SelectItem key={code} value={code}>
                      {languageNames.of(code) ?? code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="timezone">{t('timezone')}</Label>
              <Combobox
                id="timezone"
                options={zones}
                value={timezone}
                onChange={(value) => setTimezone(value ?? timezone)}
                placeholder={t('timezonePlaceholder')}
                searchPlaceholder={t('timezoneSearch')}
                emptyText={t('noTimezone')}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="default-country">{t('defaultCountry')}</Label>
              <Combobox
                id="default-country"
                options={countries}
                value={defaultCountry}
                onChange={setDefaultCountry}
                placeholder={t('defaultCountryPlaceholder')}
                searchPlaceholder={t('countrySearch')}
                emptyText={t('noCountry')}
              />
              <p className="text-sm text-muted-foreground">{t('defaultCountryHint')}</p>
            </div>
          </div>
        </div>
      </SettingsSection>

      <div>
        <Button type="submit" disabled={save.isPending}>
          {t('save')}
        </Button>
      </div>
    </form>
  );
}

/** All address fields empty → no address; required ones filled → an address; anything else is incomplete. */
export function toAddress(
  address: typeof EMPTY_ADDRESS,
): NonNullable<SettingsPatch['postalAddress']> | null | 'incomplete' {
  const trimmed = Object.fromEntries(
    Object.entries(address).map(([key, value]) => [key, value.trim()]),
  ) as typeof EMPTY_ADDRESS;
  if (Object.values(trimmed).every((value) => value === '')) return null;
  if (!trimmed.line1 || !trimmed.city || !trimmed.postalCode || !trimmed.countryCode) return 'incomplete';
  return {
    line1: trimmed.line1,
    city: trimmed.city,
    postalCode: trimmed.postalCode,
    countryCode: trimmed.countryCode,
    ...(trimmed.line2 ? { line2: trimmed.line2 } : {}),
    ...(trimmed.region ? { region: trimmed.region } : {}),
  };
}

function LogoSection({ hasLogo }: { readonly hasLogo: boolean }) {
  const t = useTranslations('workspaceSettings');
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  const input = React.useRef<HTMLInputElement>(null);
  const logo = useQuery({ queryKey: queryKeys.workspace.logo(), queryFn: fetchLogo, enabled: hasLogo });
  const blob = hasLogo ? logo.data : null;
  // The object URL belongs to this component: created for the current image, revoked when it changes or unmounts.
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  // Only `hasLogo` changes: invalidating the whole settings query would remount the form and drop unsaved edits.
  const refresh = async (nextHasLogo: boolean, message: string) => {
    client.setQueryData<OrgSettings>(queryKeys.workspace.settings(), (current) =>
      current ? { ...current, hasLogo: nextHasLogo } : current,
    );
    await client.invalidateQueries({ queryKey: queryKeys.workspace.logo() });
    (await getToast()).success(message);
  };
  const upload = useMutation({
    mutationFn: uploadLogo,
    onSuccess: () => refresh(true, t('logoUpdated')),
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });
  const remove = useMutation({
    mutationFn: async () => apiClient().DELETE('/v1/workspace/logo'),
    onSuccess: () => refresh(false, t('logoRemoved')),
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > LOGO_MAX_BYTES) {
      (await getToast()).error(t('logoTooLarge'));
      return;
    }
    upload.mutate(file);
  };

  return (
    <SettingsSection id="logo" title={t('logo')} description={t('logoHint')}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex size-20 items-center justify-center overflow-hidden rounded-md border bg-muted">
          {url ? (
            <img src={url} alt={t('logoAlt')} className="size-full object-contain" />
          ) : (
            <ImageIcon aria-hidden className="text-muted-foreground" />
          )}
        </div>
        {!hasLogo ? <p className="text-muted-foreground">{t('noLogo')}</p> : null}
        <div className="flex gap-2">
          <input
            ref={input}
            type="file"
            accept={LOGO_CONTENT_TYPES.join(',')}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={onFile}
          />
          <Button variant="outline" disabled={upload.isPending} onClick={() => input.current?.click()}>
            {hasLogo ? t('replaceLogo') : t('uploadLogo')}
          </Button>
          {hasLogo ? (
            <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {t('removeLogo')}
            </Button>
          ) : null}
        </div>
      </div>
    </SettingsSection>
  );
}
