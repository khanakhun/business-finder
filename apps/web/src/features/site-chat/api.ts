'use client';

import { networkError, toApiError } from '@bf/api-client';
import type {
  ApplyProposalResult,
  SendSiteChatMessageRequest,
  SiteChangeProposal,
  SiteChatMessage,
  SiteChatThreadDetail,
  SiteChatThreadList,
  SiteVersion,
} from '@bf/contracts';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api.ts';
import { publicEnv } from '@/lib/public-env.ts';

// The site chat's data (BF-047): threads, a thread's messages and proposals, apply/discard/undo, and the streamed
// answer of the edit agent (newline-delimited JSON events read from a fetch body).

export type ChatEvent =
  | { readonly type: 'thread'; readonly threadId: string; readonly messageId: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool'; readonly tool: string; readonly summary: string }
  | { readonly type: 'proposal'; readonly proposal: SiteChangeProposal }
  | { readonly type: 'clarification'; readonly question: string; readonly options: string[] }
  | { readonly type: 'refusal'; readonly reason: string; readonly alternatives: string[] }
  | { readonly type: 'done'; readonly message: SiteChatMessage }
  | { readonly type: 'error'; readonly code: string; readonly message: string };

export const chatKeys = {
  threads: (siteId: string) => ['site-chat', siteId, 'threads'] as const,
  thread: (siteId: string, threadId: string) => ['site-chat', siteId, 'thread', threadId] as const,
};

export function useThreads(siteId: string) {
  return useQuery({
    queryKey: chatKeys.threads(siteId),
    queryFn: async () =>
      (await apiClient().GET('/v1/sites/{id}/chat/threads', { params: { path: { id: siteId } } }))
        .data as SiteChatThreadList,
  });
}

export function useThread(siteId: string, threadId: string | null) {
  return useQuery({
    queryKey: chatKeys.thread(siteId, threadId ?? 'none'),
    queryFn: async () =>
      (
        await apiClient().GET('/v1/sites/{id}/chat/threads/{threadId}', {
          params: { path: { id: siteId, threadId: threadId as string } },
        })
      ).data as SiteChatThreadDetail,
    enabled: threadId !== null,
  });
}

/** Splits a stream of NDJSON chunks into events (a line may arrive in pieces). */
export function ndjsonSplitter(onEvent: (event: ChatEvent) => void) {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            onEvent(JSON.parse(line) as ChatEvent);
          } catch {
            // A malformed line is skipped; the next ones still count.
          }
        }
        newline = buffer.indexOf('\n');
      }
    },
    end() {
      const line = buffer.trim();
      buffer = '';
      if (line) {
        try {
          onEvent(JSON.parse(line) as ChatEvent);
        } catch {
          // ignored
        }
      }
    },
  };
}

/** Sends a message and calls `onEvent` for each event of the agent's answer; resolves when the stream ends. */
export async function sendMessage(
  siteId: string,
  body: SendSiteChatMessageRequest,
  language: string,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${publicEnv().apiUrl}/v1/sites/${siteId}/chat`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': language },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok || !response.body)
    throw toApiError(response.status, await response.json().catch(() => null));
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const splitter = ndjsonSplitter(onEvent);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    splitter.push(value);
  }
  splitter.end();
}

export async function applyProposal(
  siteId: string,
  proposalId: string,
  confirmFacts: string[],
): Promise<ApplyProposalResult> {
  const { data, error } = await apiClient().POST('/v1/sites/{id}/proposals/{proposalId}/apply', {
    params: { path: { id: siteId, proposalId } },
    body: { confirmFacts },
  });
  if (error || !data) throw error ?? new Error('Not applied');
  return data as ApplyProposalResult;
}

export async function discardProposal(siteId: string, proposalId: string): Promise<SiteChangeProposal> {
  const { data, error } = await apiClient().POST('/v1/sites/{id}/proposals/{proposalId}/discard', {
    params: { path: { id: siteId, proposalId } },
  });
  if (error || !data) throw error ?? new Error('Not discarded');
  return data as SiteChangeProposal;
}

/** Undo an applied proposal: the version before it, as a new version (history is never rewritten). */
export async function undoProposal(
  siteId: string,
  toVersionId: string,
  fromVersionId: string,
): Promise<SiteVersion> {
  const { data, error } = await apiClient().POST('/v1/sites/{id}/rollback', {
    params: { path: { id: siteId } },
    body: { versionId: toVersionId, baseVersionId: fromVersionId },
  });
  if (error || !data) throw error ?? new Error('Not undone');
  return data as SiteVersion;
}
