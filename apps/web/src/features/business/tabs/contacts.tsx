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
import { Tooltip, TooltipContent, TooltipTrigger } from '@bf/ui/components/tooltip';
import { ContactRoundIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
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

const EMAIL_SUBTYPES = new Set(['generic', 'personal', 'department']);

/** What an e-mail is (shared mailbox, a person, a department) and whether it is webmail. */
function EmailKind({ contact }: { readonly contact: Contact }) {
  const t = useTranslations('business.contacts');
  if (contact.type !== 'email') {
    return contact.subtype && contact.subtype !== 'unknown' ? (
      <div className="text-xs text-muted-foreground">{contact.subtype}</div>
    ) : null;
  }
  const subtype = EMAIL_SUBTYPES.has(contact.subtype) ? contact.subtype : null;
  if (!subtype && !contact.isFreeMail) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {subtype ? (
        <Badge variant="outline" className="font-normal">
          {t(`subtypes.${subtype as 'generic' | 'personal' | 'department'}`)}
        </Badge>
      ) : null}
      {contact.isFreeMail ? (
        <Badge variant="outline" className="font-normal">
          {t('freeMail')}
        </Badge>
      ) : null}
    </div>
  );
}

/** Where the business's own site shows the address ("on the contact page"), linked to that page. */
function PublishedOn({ contact }: { readonly contact: Contact }) {
  const t = useTranslations('business.contacts');
  const context = contact.publishedContext;
  if (!context) return null;
  const page = t(`pageKinds.${context.pageKind}`);
  const url = context.pageUrl ? safeWebUrl(context.pageUrl) : null;
  return (
    <div className="text-xs text-muted-foreground">
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="hover:underline">
          {t('publishedOn', { page })}
        </a>
      ) : (
        t('publishedOn', { page })
      )}
    </div>
  );
}

/** The verdict as a badge; what the verifier saw on hover or focus. */
function VerificationBadge({ contact }: { readonly contact: Contact }) {
  const t = useTranslations('business.contacts.details');
  const verification = useTranslations('business.verification');
  const format = useFormatter();
  const badge = (
    <Badge
      variant={contact.verificationStatus === 'valid' ? 'secondary' : 'outline'}
      tabIndex={contact.verificationDetails ? 0 : undefined}
      data-testid={`verification-${contact.normalizedValue}`}
    >
      {verification(contact.verificationStatus)}
    </Badge>
  );
  const details = contact.verificationDetails;
  if (!details) return badge;
  const lines = [
    contact.verifiedAt
      ? t('checked', {
          date: format.dateTime(new Date(contact.verifiedAt), { dateStyle: 'medium' }),
          verifier: t(`verifiers.${details.checkedVia}`),
        })
      : t(`verifiers.${details.checkedVia}`),
    t(`mailbox.${details.reachable}`),
    details.isCatchAll ? t('catchAll') : null,
    details.isRoleAccount ? t('role') : null,
    details.mxAcceptsMail === false ? t('noMx') : null,
    details.provider ? t('provider', { provider: details.provider }) : null,
  ].filter((line): line is string => line !== null);
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>
        <ul className="grid gap-0.5">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/** Every contact point of the business, with where it was found and whether it was verified. */
export function ContactsTab({ business }: BusinessTabProps) {
  const t = useTranslations('business.contacts');
  const types = useTranslations('business.contactTypes');
  const sources = useTranslations('business.sources');
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
  const verify = useBusinessMutation(
    business.id,
    async (contactId: string) =>
      (await apiClient().POST('/v1/contacts/{id}/verify', { params: { path: { id: contactId } } })).data,
    { success: () => t('verifyStarted') },
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
                    <EmailKind contact={contact} />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <ContactValue contact={contact} />
                    {contact.personName ? (
                      <div className="text-xs text-muted-foreground">{contact.personName}</div>
                    ) : null}
                    <PublishedOn contact={contact} />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex flex-wrap items-center gap-2">
                      <VerificationBadge contact={contact} />
                      {canWrite && contact.type === 'email' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('verifyLabel', { value: contact.value })}
                          disabled={verify.isPending && verify.variables === contact.id}
                          onClick={() => verify.mutate(contact.id)}
                        >
                          {t('verify')}
                        </Button>
                      ) : null}
                    </div>
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
