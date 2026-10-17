'use client';

import type { SiteChangeProposal, SiteChatPart } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Textarea } from '@bf/ui/components/textarea';
import { usePuck } from '@puckeditor/core';
import {
  CircleAlertIcon,
  LoaderCircleIcon,
  PlusIcon,
  SendIcon,
  ShieldAlertIcon,
  WrenchIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useSiteEditor, useSiteEditorActions } from '@/features/site-editor/context.tsx';
import { usePermission } from '@/lib/session.tsx';
import { ProposalCard } from './proposal-card.tsx';
import { suggestionsFor } from './suggestions.ts';
import { useSiteChat } from './use-site-chat.ts';

// The chat panel of the site editor (BF-047): say what to change; the edit agent answers with a proposal to preview
// and apply, a question, or a kind refusal. It knows what is selected (page, section, language) and says so.

export function SiteChatPanel() {
  const t = useTranslations('siteChat');
  const suggestion = useTranslations('siteChat.suggestions');
  const { siteId, pageId, locale, spec } = useSiteEditor();
  const { chat } = useSiteEditorActions();
  const canEdit = usePermission('sites:generate');
  const selected = usePuck().selectedItem as { type?: string; props?: { id?: string } } | null;
  const blockId = selected?.props?.id ?? null;
  const blockType = blockId
    ? (spec.pages.find((page) => page.id === pageId)?.blocks.find((block) => block.id === blockId)?.type ??
      null)
    : null;
  const pageTitle = spec.pages.find((page) => page.id === pageId)?.title[locale] ?? pageId;
  const state = useSiteChat(siteId);
  const [draft, setDraft] = React.useState('');
  const endRef = React.useRef<HTMLDivElement>(null);
  const proposals = new Map<string, SiteChangeProposal>(
    (state.thread.data?.proposals ?? []).map((proposal) => [proposal.id, proposal]),
  );
  const messages = state.thread.data?.messages ?? [];
  React.useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, state.live?.text, state.live?.parts.length]);

  const send = (text: string) => {
    const message = text.trim();
    if (!message || state.busy) return;
    setDraft('');
    void state.send(message, {
      pageId,
      ...(blockId ? { blockId } : {}),
      locale,
      baseVersionId: chat.baseVersionId,
    });
  };
  const contextLabel = blockType
    ? t('context.block', { page: pageTitle, block: blockType, locale: locale.toUpperCase() })
    : t('context.page', { page: pageTitle, locale: locale.toUpperCase() });

  if (!canEdit) return <p className="p-4 text-sm text-muted-foreground">{t('readOnly')}</p>;
  return (
    <div className="flex h-full min-h-[24rem] flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate rounded-full bg-muted px-2 py-0.5 text-xs" title={contextLabel}>
          {contextLabel}
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => state.open(null)}
          disabled={state.busy}
        >
          <PlusIcon aria-hidden />
          {t('newThread')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto" aria-live="polite" aria-busy={state.busy}>
        {messages.length === 0 && !state.live ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : null}
        {messages.map((message) => (
          <Message
            key={message.id}
            author={message.role}
            parts={message.parts}
            proposals={proposals}
            onOption={send}
            onChanged={() => void state.refresh()}
          />
        ))}
        {state.live ? (
          <>
            <Message
              author="user"
              parts={[{ type: 'text', text: state.live.message }]}
              proposals={proposals}
              onOption={send}
              onChanged={() => undefined}
            />
            <Message
              author="assistant"
              parts={[
                ...(state.live.text ? [{ type: 'text' as const, text: state.live.text }] : []),
                ...state.live.parts,
              ]}
              proposals={proposals}
              onOption={send}
              onChanged={() => void state.refresh()}
            />
            {state.busy ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                {t('thinking')}
              </p>
            ) : null}
            {state.live.error ? (
              <p role="alert" className="flex items-center gap-2 text-xs text-destructive">
                <CircleAlertIcon aria-hidden className="size-3" />
                {t('failed')}
              </p>
            ) : null}
          </>
        ) : null}
        <div ref={endRef} />
      </div>
      <div className="flex flex-wrap gap-1">
        {suggestionsFor(blockType).map((key) => (
          <Button
            key={key}
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            disabled={state.busy}
            onClick={() => send(suggestion(key as never))}
          >
            {suggestion(key as never)}
          </Button>
        ))}
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
      >
        <Textarea
          value={draft}
          rows={2}
          maxLength={4000}
          placeholder={t('placeholder')}
          aria-label={t('placeholder')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send(draft);
            }
          }}
        />
        <Button type="submit" size="icon" disabled={state.busy || draft.trim() === ''} aria-label={t('send')}>
          <SendIcon aria-hidden />
        </Button>
      </form>
    </div>
  );
}

function Message({
  author,
  parts,
  proposals,
  onOption,
  onChanged,
}: {
  readonly author: 'user' | 'assistant';
  readonly parts: readonly SiteChatPart[];
  readonly proposals: ReadonlyMap<string, SiteChangeProposal>;
  readonly onOption: (text: string) => void;
  readonly onChanged: () => void;
}) {
  const t = useTranslations('siteChat');
  const tools = parts.filter((part): part is Extract<SiteChatPart, { type: 'tool' }> => part.type === 'tool');
  return (
    <div className={author === 'user' ? 'ml-6 rounded-lg bg-lagoon-wash p-2 text-sm' : 'space-y-2 text-sm'}>
      {tools.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="flex cursor-pointer items-center gap-1">
            <WrenchIcon aria-hidden className="size-3" />
            {[...new Set(tools.map((tool) => tool.summary))].slice(0, 3).join(' · ')}
            {tools.length > 3 ? ` · +${tools.length - 3}` : ''}
          </summary>
          <ul className="mt-1 space-y-0.5 pl-4">
            {tools.map((tool, index) => (
              <li key={`${tool.tool}-${index}`}>{tool.summary}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {parts.map((part, index) => {
        const key = `${part.type}-${index}`;
        switch (part.type) {
          case 'text':
            return (
              <p key={key} className="whitespace-pre-wrap">
                {part.text}
              </p>
            );
          case 'proposal': {
            const proposal = proposals.get(part.proposalId);
            return proposal ? (
              <ProposalCard key={key} proposal={proposal} onChanged={onChanged} />
            ) : (
              <p key={key} className="text-xs text-muted-foreground">
                {t('loadingProposal')}
              </p>
            );
          }
          case 'clarification':
            return (
              <div key={key} className="space-y-1">
                <p>{part.question}</p>
                <div className="flex flex-wrap gap-1">
                  {part.options.map((option) => (
                    <Button
                      key={option}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => onOption(option)}
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              </div>
            );
          case 'refusal':
            return (
              <div
                key={key}
                className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 dark:bg-amber-950"
              >
                <p className="flex gap-1">
                  <ShieldAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                  {part.reason}
                </p>
                <div className="flex flex-wrap gap-1">
                  {part.alternatives.map((alternative) => (
                    <Button
                      key={alternative}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-auto py-1 text-left text-xs whitespace-normal"
                      onClick={() => onOption(alternative)}
                    >
                      {alternative}
                    </Button>
                  ))}
                </div>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
