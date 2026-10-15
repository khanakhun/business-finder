'use client';

import type { Note } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Label } from '@bf/ui/components/label';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Textarea } from '@bf/ui/components/textarea';
import { PinIcon, PinOffIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { apiClient } from '@/lib/api.ts';
import { usePermission, useSession } from '@/lib/session.tsx';
import { useBusinessMutation, useNotes, useTeammates } from './api.ts';
import { SafeMarkdown } from './markdown.tsx';

function NoteItem({ businessId, note }: { readonly businessId: string; readonly note: Note }) {
  const t = useTranslations('business.notes');
  const format = useFormatter();
  const me = useSession();
  const { byUser } = useTeammates();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(note.bodyMarkdown);
  const mine = note.authorId === me.user.id;
  const update = useBusinessMutation(
    businessId,
    async (patch: { bodyMarkdown?: string; pinned?: boolean }) =>
      (await apiClient().PATCH('/v1/notes/{id}', { params: { path: { id: note.id } }, body: patch })).data,
  );
  const remove = useBusinessMutation(
    businessId,
    async () => (await apiClient().DELETE('/v1/notes/{id}', { params: { path: { id: note.id } } })).data,
    { success: () => t('deleted') },
  );
  const author = note.authorId ? (byUser.get(note.authorId)?.name ?? t('someone')) : t('someone');
  return (
    <li
      className={`space-y-2 rounded-lg border p-3 ${note.pinned ? 'border-lagoon/50 bg-lagoon-wash/40' : ''}`}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {t('byline', { author, when: format.relativeTime(new Date(note.createdAt)) })}
          {note.pinned ? <span className="ml-2 font-medium text-lagoon">{t('pinned')}</span> : null}
        </span>
        {mine ? (
          <span className="flex items-center gap-1">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={note.pinned ? t('unpin') : t('pin')}
              onClick={() => update.mutate({ pinned: !note.pinned })}
            >
              {note.pinned ? <PinOffIcon aria-hidden /> : <PinIcon aria-hidden />}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(note.bodyMarkdown);
                setEditing((value) => !value);
              }}
            >
              {t('edit')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => remove.mutate(undefined)}>
              {t('delete')}
            </Button>
          </span>
        ) : null}
      </div>
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim())
              update.mutate({ bodyMarkdown: draft.trim() }, { onSuccess: () => setEditing(false) });
          }}
        >
          <Textarea
            aria-label={t('edit')}
            value={draft}
            maxLength={20_000}
            rows={4}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!draft.trim() || update.isPending}>
              {t('save')}
            </Button>
          </div>
        </form>
      ) : (
        <SafeMarkdown>{note.bodyMarkdown}</SafeMarkdown>
      )}
    </li>
  );
}

/** Notes on the business: a composer (markdown) and the list, pinned first. */
export function NotesSection({ businessId }: { readonly businessId: string }) {
  const t = useTranslations('business.notes');
  const canWrite = usePermission('business:write');
  const notes = useNotes(businessId);
  const [body, setBody] = React.useState('');
  const id = React.useId();
  const add = useBusinessMutation(
    businessId,
    async (bodyMarkdown: string) =>
      (
        await apiClient().POST('/v1/businesses/{id}/notes', {
          params: { path: { id: businessId } },
          body: { bodyMarkdown, pinned: false },
        })
      ).data,
  );
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3">
      <h2 id={`${id}-title`} className="text-base font-semibold">
        {t('title')}
      </h2>
      {canWrite ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim()) add.mutate(body.trim(), { onSuccess: () => setBody('') });
          }}
        >
          <Label htmlFor={id} className="sr-only">
            {t('new')}
          </Label>
          <Textarea
            id={id}
            value={body}
            rows={3}
            maxLength={20_000}
            placeholder={t('placeholder')}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
                event.currentTarget.form?.requestSubmit();
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{t('hint')}</span>
            <Button type="submit" size="sm" disabled={!body.trim() || add.isPending}>
              {t('add')}
            </Button>
          </div>
        </form>
      ) : null}
      {notes.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : (notes.data?.items.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {(notes.data?.items ?? []).map((note) => (
            <NoteItem key={note.id} businessId={businessId} note={note} />
          ))}
        </ul>
      )}
    </section>
  );
}
