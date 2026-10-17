import { Injectable } from '@nestjs/common';
import type {
  HealthReport,
  MailboxCtx,
  MailboxProvider,
  RawInbound,
  SendResult,
  SentProbe,
  SyncCursor,
} from '../../../application/mailbox/ports.ts';
import { MailboxProviderError } from '../../../domain/mailbox/errors.ts';
import { providerFetch } from '../http.ts';
import { messageIdOf, parseHeaders } from '../mime-headers.ts';

// Gmail / Google Workspace (BF-050): `users.messages.send` with base64url raw MIME (and the thread id for follow-ups),
// then the stored message's actual Message-ID is read back (Gmail may replace a client-supplied one). Sync is
// history-based polling (`users.history.list`); Pub/Sub push (`users.watch`) is not wired yet (needs a public topic).

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PAGE = 100;
const MAX_MESSAGES = 200;

const auth = async (mailbox: MailboxCtx) => ({ authorization: `Bearer ${await mailbox.accessToken()}` });

@Injectable()
export class GmailProvider implements MailboxProvider {
  readonly kind = 'gmail' as const;
  readonly capabilities = { push: false, threads: true, rawMime: true } as const;

  async sendRaw(
    mailbox: MailboxCtx,
    mime: Buffer,
    options: { readonly threadHint?: string; readonly signal: AbortSignal },
  ): Promise<SendResult> {
    const { body } = await providerFetch('gmail', 'mailbox-send', `${API}/messages/send`, {
      method: 'POST',
      headers: { ...(await auth(mailbox)), 'content-type': 'application/json' },
      body: JSON.stringify({
        raw: mime.toString('base64url'),
        ...(options.threadHint ? { threadId: options.threadHint } : {}),
      }),
      signal: options.signal,
    });
    const sent = body as { id?: string; threadId?: string };
    if (!sent.id) throw new MailboxProviderError('gmail', 'unknown', 'Gmail returned no message id');
    const fallback = messageIdOf(parseHeaders(mime));
    let rfc822MessageId = fallback;
    try {
      const { body: meta } = await providerFetch(
        'gmail',
        'mailbox-api',
        `${API}/messages/${encodeURIComponent(sent.id)}?format=metadata&metadataHeaders=Message-ID`,
        { headers: await auth(mailbox) },
      );
      const headers = (meta as { payload?: { headers?: { name?: string; value?: string }[] } }).payload
        ?.headers;
      rfc822MessageId = headers?.find((h) => h.name?.toLowerCase() === 'message-id')?.value ?? fallback;
    } catch {
      // The message is sent: keep the id we put in it rather than failing the send.
    }
    if (!rfc822MessageId)
      throw new MailboxProviderError('gmail', 'unknown', 'No Message-ID for the sent message');
    return {
      providerMessageId: sent.id,
      rfc822MessageId,
      ...(sent.threadId ? { providerThreadId: sent.threadId } : {}),
    };
  }

  /** By our Message-ID (`rfc822msgid:`), else recent sent mail to the recipient confirmed by `X-BF-Outbound-Id`. */
  async findSent(mailbox: MailboxCtx, probe: SentProbe, signal: AbortSignal): Promise<SendResult | null> {
    const search = async (q: string) => {
      const { body } = await providerFetch(
        'gmail',
        'mailbox-api',
        `${API}/messages?maxResults=10&q=${encodeURIComponent(q)}`,
        { headers: await auth(mailbox), signal },
      );
      return (body as { messages?: { id: string; threadId?: string }[] }).messages ?? [];
    };
    const byId = await search(`in:sent rfc822msgid:${probe.rfc822MessageId.replace(/[<>]/g, '')}`);
    const candidates =
      byId.length > 0
        ? byId
        : await search(`in:sent to:${probe.to} after:${Math.floor(probe.since.getTime() / 1000) - 60}`);
    for (const candidate of candidates) {
      const { body } = await providerFetch(
        'gmail',
        'mailbox-api',
        `${API}/messages/${encodeURIComponent(candidate.id)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=X-BF-Outbound-Id`,
        { headers: await auth(mailbox), signal },
      );
      const headers = (body as { payload?: { headers?: { name?: string; value?: string }[] } }).payload
        ?.headers;
      const header = (name: string) => headers?.find((h) => h.name?.toLowerCase() === name)?.value?.trim();
      const messageId = header('message-id');
      if (messageId === probe.rfc822MessageId || header('x-bf-outbound-id') === probe.outboundId)
        return {
          providerMessageId: candidate.id,
          rfc822MessageId: messageId ?? probe.rfc822MessageId,
          ...(candidate.threadId ? { providerThreadId: candidate.threadId } : {}),
        };
    }
    return null;
  }

  private async historyId(mailbox: MailboxCtx): Promise<string> {
    const { body } = await providerFetch('gmail', 'mailbox-api', `${API}/profile`, {
      headers: await auth(mailbox),
    });
    return String((body as { historyId?: string }).historyId ?? '0');
  }

  async syncChanges(mailbox: MailboxCtx, cursor: SyncCursor | null) {
    // First sync (or a cursor of another kind): start from now, history is not imported.
    if (!cursor || cursor.kind !== 'gmail')
      return {
        messages: [] as RawInbound[],
        next: { kind: 'gmail' as const, historyId: await this.historyId(mailbox) },
      };
    const ids: string[] = [];
    let pageToken: string | undefined;
    let latest = cursor.historyId;
    try {
      do {
        const params = new URLSearchParams({
          startHistoryId: cursor.historyId,
          historyTypes: 'messageAdded',
          labelId: 'INBOX',
          maxResults: String(PAGE),
          ...(pageToken ? { pageToken } : {}),
        });
        const { body } = await providerFetch('gmail', 'mailbox-api', `${API}/history?${params}`, {
          headers: await auth(mailbox),
        });
        const page = body as {
          history?: { messagesAdded?: { message?: { id?: string } }[] }[];
          historyId?: string;
          nextPageToken?: string;
        };
        for (const entry of page.history ?? [])
          for (const added of entry.messagesAdded ?? []) if (added.message?.id) ids.push(added.message.id);
        latest = page.historyId ?? latest;
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < MAX_MESSAGES);
    } catch (error) {
      // A history id older than Gmail keeps (404): start over from now.
      if (error instanceof MailboxProviderError && error.reason === 'rejected')
        return {
          messages: [] as RawInbound[],
          next: { kind: 'gmail' as const, historyId: await this.historyId(mailbox) },
        };
      throw error;
    }
    const messages: RawInbound[] = [];
    for (const id of [...new Set(ids)].slice(0, MAX_MESSAGES)) {
      const { body } = await providerFetch(
        'gmail',
        'mailbox-api',
        `${API}/messages/${encodeURIComponent(id)}?format=raw`,
        {
          headers: await auth(mailbox),
        },
      );
      const message = body as { id: string; threadId?: string; raw?: string; internalDate?: string };
      const raw = message.raw ? Buffer.from(message.raw, 'base64url') : null;
      const headers = raw ? parseHeaders(raw) : {};
      messages.push({
        providerMessageId: message.id,
        providerThreadId: message.threadId ?? null,
        rfc822MessageId: messageIdOf(headers),
        headers,
        raw,
        receivedAt: message.internalDate ? new Date(Number(message.internalDate)) : null,
      });
    }
    return { messages, next: { kind: 'gmail' as const, historyId: latest } };
  }

  async checkHealth(mailbox: MailboxCtx): Promise<HealthReport> {
    try {
      await this.historyId(mailbox);
      return { tokenOk: true, reachable: true, quotaOk: true, error: null };
    } catch (error) {
      if (!(error instanceof MailboxProviderError)) throw error;
      return {
        tokenOk: !error.needsReconnect,
        reachable: error.reason !== 'unreachable',
        quotaOk: error.reason !== 'quota_exceeded' && error.reason !== 'rate_limited',
        error: { code: error.reason, message: error.message },
      };
    }
  }
}
