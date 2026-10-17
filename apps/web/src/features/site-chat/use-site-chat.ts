'use client';

import type { SiteChatContext, SiteChatPart } from '@bf/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import * as React from 'react';
import { type ChatEvent, chatKeys, sendMessage, useThread } from './api.ts';

// The chat's state (BF-047): the open thread (its stored messages and proposals) and the turn being answered — the
// person's message and the agent's text, tool activity, proposals, questions and refusals as they stream in.

export interface LiveTurn {
  readonly message: string;
  readonly text: string;
  readonly parts: readonly SiteChatPart[];
  readonly error: string | null;
}

export function useSiteChat(siteId: string) {
  const client = useQueryClient();
  const locale = useLocale();
  const [threadId, setThreadId] = React.useState<string | null>(null);
  const [live, setLive] = React.useState<LiveTurn | null>(null);
  const thread = useThread(siteId, threadId);
  const abort = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => abort.current?.abort(), []);

  const send = async (message: string, context: SiteChatContext) => {
    if (live && !live.error) return;
    const controller = new AbortController();
    abort.current = controller;
    let current: LiveTurn = { message, text: '', parts: [], error: null };
    let thread = threadId;
    const update = (next: LiveTurn) => {
      current = next;
      setLive(next);
    };
    update(current);
    const onEvent = (event: ChatEvent) => {
      switch (event.type) {
        case 'thread':
          thread = event.threadId;
          setThreadId(event.threadId);
          break;
        case 'text':
          update({ ...current, text: current.text + event.text });
          break;
        case 'tool':
          update({
            ...current,
            parts: [...current.parts, { type: 'tool', tool: event.tool, summary: event.summary }],
          });
          break;
        case 'proposal':
          // The card reads the proposal from the thread: fetch it now.
          if (thread) void client.invalidateQueries({ queryKey: chatKeys.thread(siteId, thread) });
          update({
            ...current,
            parts: [...current.parts, { type: 'proposal', proposalId: event.proposal.id }],
          });
          break;
        case 'clarification':
          update({
            ...current,
            parts: [
              ...current.parts,
              { type: 'clarification', question: event.question, options: event.options },
            ],
          });
          break;
        case 'refusal':
          update({
            ...current,
            parts: [
              ...current.parts,
              { type: 'refusal', reason: event.reason, alternatives: event.alternatives },
            ],
          });
          break;
        case 'error':
          update({ ...current, error: event.message });
          break;
        default:
          break;
      }
    };
    try {
      await sendMessage(
        siteId,
        { ...(threadId ? { threadId } : {}), message, context },
        locale,
        onEvent,
        controller.signal,
      );
      if (thread) await client.invalidateQueries({ queryKey: chatKeys.thread(siteId, thread) });
      await client.invalidateQueries({ queryKey: chatKeys.threads(siteId) });
      if (!current.error) setLive(null);
    } catch {
      update({ ...current, error: 'failed' });
    }
  };

  return {
    threadId,
    open: (id: string | null) => {
      setLive(null);
      setThreadId(id);
    },
    thread,
    live,
    busy: live !== null && live.error === null,
    send,
    refresh: () =>
      threadId
        ? client.invalidateQueries({ queryKey: chatKeys.thread(siteId, threadId) })
        : Promise.resolve(),
  };
}
