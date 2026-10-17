'use client';

import type { SaveSiteLegalProfileRequest, SiteLegalProfile } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { getToast } from '@/lib/toast.tsx';
import { useGoLiveActions } from './api.ts';

// The legal profile (BF-062): the legal notice and privacy pages are generated from it. Reading and accepting the
// privacy notice, and the client's confirmation that they reviewed the content, are recorded with each save.

const FIELDS = [
  { key: 'businessLegalName', required: true },
  { key: 'legalForm', required: false },
  { key: 'registration', required: false },
  { key: 'vatNumber', required: false },
  { key: 'address', required: true },
  { key: 'phone', required: false },
  { key: 'email', required: true, type: 'email' },
  { key: 'publicationDirector', required: false },
  { key: 'dpoContact', required: false },
] as const;
type FieldKey = (typeof FIELDS)[number]['key'];

const initial = (profile: SiteLegalProfile | null): Record<FieldKey, string> => ({
  businessLegalName: profile?.businessLegalName ?? '',
  legalForm: profile?.legalForm ?? '',
  registration: profile?.registration ?? '',
  vatNumber: profile?.vatNumber ?? '',
  address: profile?.address ?? '',
  phone: profile?.phone ?? '',
  email: profile?.email ?? '',
  publicationDirector: profile?.publicationDirector ?? '',
  dpoContact: profile?.dpoContact ?? '',
});

export function LegalStep({
  siteId,
  profile,
}: {
  readonly siteId: string;
  readonly profile: SiteLegalProfile | null;
}) {
  const t = useTranslations('goLive.legal');
  const format = useFormatter();
  const actions = useGoLiveActions(siteId);
  const [values, setValues] = React.useState(() => initial(profile));
  const [acknowledge, setAcknowledge] = React.useState(false);
  const [confirmedBy, setConfirmedBy] = React.useState('');
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const toast = await getToast();
    const optional = (value: string) => (value.trim() ? value.trim() : null);
    const body: SaveSiteLegalProfileRequest = {
      businessLegalName: values.businessLegalName,
      legalForm: optional(values.legalForm),
      registration: optional(values.registration),
      vatNumber: optional(values.vatNumber),
      address: values.address,
      phone: optional(values.phone),
      email: values.email,
      publicationDirector: optional(values.publicationDirector),
      dpoContact: optional(values.dpoContact),
      acknowledgePrivacy: acknowledge,
      contentConfirmedBy: optional(confirmedBy),
    };
    try {
      await actions.saveLegal.mutateAsync(body);
      toast.success(t('saved'));
      setAcknowledge(false);
      setConfirmedBy('');
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };

  return (
    <form className="space-y-4" onSubmit={save}>
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((field) => (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={`legal-${field.key}`}>
              {t(`fields.${field.key}`)}
              {field.required ? ' *' : ''}
            </Label>
            <Input
              id={`legal-${field.key}`}
              type={'type' in field ? field.type : 'text'}
              required={field.required}
              value={values[field.key]}
              onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
            />
          </div>
        ))}
      </div>
      <div className="space-y-2 rounded-lg border p-3 text-sm">
        <h3 className="font-medium">{t('privacyTitle')}</h3>
        {profile?.privacyAcknowledgedAt ? (
          <p className="text-muted-foreground">
            {t('privacyDone', { date: date(profile.privacyAcknowledgedAt) })}
          </p>
        ) : null}
        <div className="flex items-start gap-2">
          <Checkbox
            id="legal-acknowledge"
            checked={acknowledge}
            onCheckedChange={(checked) => setAcknowledge(checked === true)}
          />
          <Label htmlFor="legal-acknowledge" className="font-normal">
            {t('privacyAcknowledge')}
          </Label>
        </div>
      </div>
      <div className="space-y-2 rounded-lg border p-3 text-sm">
        <h3 className="font-medium">{t('confirmTitle')}</h3>
        {profile?.contentConfirmedBy && profile.contentConfirmedAt ? (
          <p className="text-muted-foreground">
            {t('confirmDone', { name: profile.contentConfirmedBy, date: date(profile.contentConfirmedAt) })}
          </p>
        ) : null}
        <Label htmlFor="legal-confirmed-by" className="font-normal">
          {t('confirmBy')}
        </Label>
        <Input
          id="legal-confirmed-by"
          value={confirmedBy}
          maxLength={120}
          onChange={(event) => setConfirmedBy(event.target.value)}
        />
      </div>
      <Button type="submit" disabled={actions.saveLegal.isPending}>
        {t('save')}
      </Button>
    </form>
  );
}
