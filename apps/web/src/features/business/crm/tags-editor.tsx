'use client';

import type { CrmState } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Input } from '@bf/ui/components/input';
import { PlusIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { apiClient } from '@/lib/api.ts';
import { useBusinessMutation } from '../api.ts';

export function TagsEditor({
  businessId,
  tags,
  disabled,
}: {
  readonly businessId: string;
  readonly tags: readonly string[];
  readonly disabled: boolean;
}) {
  const t = useTranslations('business.tags');
  const [draft, setDraft] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const update = useBusinessMutation(
    businessId,
    async (change: { add?: string[]; remove?: string[] }) =>
      (
        await apiClient().POST('/v1/businesses/{id}/tags', {
          params: { path: { id: businessId } },
          body: { add: change.add ?? [], remove: change.remove ?? [] },
        })
      ).data as CrmState,
  );
  const submit = () => {
    const tag = draft.trim();
    if (!tag) return;
    update.mutate({ add: [tag] }, { onSuccess: () => setDraft('') });
  };
  return (
    <fieldset className="flex min-w-0 flex-wrap items-center gap-1.5">
      <legend className="sr-only">{t('label')}</legend>
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1 pr-1">
          {tag}
          {disabled ? null : (
            <button
              type="button"
              className="rounded-sm p-0.5 hover:bg-background/60 focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={t('remove', { tag })}
              onClick={() => update.mutate({ remove: [tag] })}
            >
              <XIcon aria-hidden className="size-3" />
            </button>
          )}
        </Badge>
      ))}
      {disabled ? (
        tags.length === 0 ? (
          <span className="text-sm text-muted-foreground">{t('none')}</span>
        ) : null
      ) : adding ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            autoFocus
            value={draft}
            maxLength={50}
            aria-label={t('new')}
            placeholder={t('new')}
            className="h-7 w-32"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setAdding(false);
            }}
            onBlur={() => (draft.trim() ? undefined : setAdding(false))}
          />
          <Button type="submit" size="sm" variant="ghost" disabled={!draft.trim() || update.isPending}>
            {t('add')}
          </Button>
        </form>
      ) : (
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setAdding(true)}>
          <PlusIcon aria-hidden />
          {t('addTag')}
        </Button>
      )}
    </fieldset>
  );
}
