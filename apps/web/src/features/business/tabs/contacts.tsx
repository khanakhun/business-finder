'use client';

import { CONTACT_TYPES, type Contact, type ContactType } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { ContactRoundIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { safeWebUrl } from '@/features/search/safe-url.ts';
import { apiClient } from '@/lib/api.ts';
import { usePermission } from '@/lib/session.tsx';
import { useBusinessMutation, useContacts } from '../api.ts';
import type { BusinessTabProps } from './registry.ts';

function ContactValue({ contact }: { readonly contact: Contact }) {
  const url = contact.type === 'website_form' || contact.type === 'social' ? safeWebUrl(contact.value) : null;
  if (url)
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-lagoon hover:underline"
      >
        {contact.value}
      </a>
    );
  return <span className="break-all">{contact.value}</span>;
}

/** Every contact point of the business, with where it was found and whether it was verified. */
export function ContactsTab({ business }: BusinessTabProps) {
  const t = useTranslations('business.contacts');
  const types = useTranslations('business.contactTypes');
  const sources = useTranslations('business.sources');
  const verification = useTranslations('business.verification');
  const errorLabels = useErrorLabels();
  const canWrite = usePermission('business:write');
  const contacts = useContacts(business.id);
  const [type, setType] = React.useState<ContactType>('email');
  const [value, setValue] = React.useState('');
  const add = useBusinessMutation(
    business.id,
    async (body: { type: ContactType; value: string }) =>
      (
        await apiClient().POST('/v1/businesses/{id}/contacts', {
          params: { path: { id: business.id } },
          body,
        })
      ).data,
    { success: () => t('added') },
  );
  const valueId = React.useId();

  return (
    <div className="space-y-6">
      {contacts.isError ? (
        <ErrorState
          problem={toProblemLike(contacts.error, t('error'))}
          labels={errorLabels}
          onRetry={() => void contacts.refetch()}
        />
      ) : contacts.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : (contacts.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          icon={<ContactRoundIcon aria-hidden />}
          title={t('emptyTitle')}
          description={t('empty')}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('caption')}</caption>
            <thead className="bg-surface-sunken text-left text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('type')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('value')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('verification')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('source')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {(contacts.data?.items ?? []).map((contact) => (
                <tr key={contact.id}>
                  <td className="px-3 py-2 align-top">
                    <div>{types(contact.type)}</div>
                    {contact.subtype && contact.subtype !== 'unknown' ? (
                      <div className="text-xs text-muted-foreground">{contact.subtype}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <ContactValue contact={contact} />
                    {contact.personName ? (
                      <div className="text-xs text-muted-foreground">{contact.personName}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Badge variant={contact.verificationStatus === 'valid' ? 'secondary' : 'outline'}>
                      {verification(contact.verificationStatus)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 align-top text-muted-foreground">{sources(contact.source)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canWrite ? (
        <form
          className="flex flex-wrap items-end gap-2"
          aria-label={t('addTitle')}
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) add.mutate({ type, value: value.trim() }, { onSuccess: () => setValue('') });
          }}
        >
          <div className="space-y-1">
            <Label>{t('type')}</Label>
            <Select value={type} onValueChange={(next) => setType(next as ContactType)}>
              <SelectTrigger aria-label={t('type')} className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTACT_TYPES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {types(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-56 flex-1 space-y-1">
            <Label htmlFor={valueId}>{t('value')}</Label>
            <Input
              id={valueId}
              value={value}
              maxLength={500}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={!value.trim() || add.isPending}>
            {t('add')}
          </Button>
          <p className="basis-full text-xs text-muted-foreground">{t('addHint')}</p>
        </form>
      ) : null}
    </div>
  );
}
