import { Injectable } from '@nestjs/common';
import type {
  HealthReport,
  MailboxCtx,
  MailboxProvider,
  RawInbound,
  SendResult,
  SyncCursor,
} from '../../../application/mailbox/ports.ts';
import { MailboxProviderError } from '../../../domain/mailbox/errors.ts';
import { providerFetch } from '../http.ts';
import { messageIdOf, parseHeaders } from '../mime-headers.ts';

// Microsoft 365 via Graph (BF-050). `POST /me/sendMail` with MIME returns no identifiers, so the message is created
// from the MIME as a draft (`POST /me/messages`, which returns `internetMessageId` and `conversationId`) and then sent.
// Sync is a delta query on the Inbox; change-notification subscriptions are not wired yet (need a public endpoint).

const API = 'https://graph.microsoft.com/v1.0/me';
const MAX_PAGES = 10;

const auth = async (mailbox: MailboxCtx) => ({ authorization: `Bearer ${await mailbox.accessToken()}` });

@Injectable()
export class GraphProvider implements MailboxProvider {
  readonly kind = 'graph' as const;
  readonly capabilities = { push: false, threads: true, rawMime: true } as const;

  async sendRaw(
    mailbox: MailboxCtx,
    mime: Buffer,
    options: { readonly threadHint?: string; readonly signal: AbortSignal },
  ): Promise<SendResult> {
    const { body } = await providerFetch('graph', 'mailbox-send', `${API}/messages`, {
      method: 'POST',
      headers: { ...(await auth(mailbox)), 'content-type': 'text/plain' },
      body: mime.toString('base64'),
      signal: options.signal,
    });
    const draft = body as { id?: string; internetMessageId?: string; conversationId?: string };
    if (!draft.id) throw new MailboxProviderError('graph', 'unknown', 'Graph returned no message id');
    await providerFetch('graph', 'mailbox-send', `${API}/messages/${encodeURIComponent(draft.id)}/send`, {
      method: 'POST',
      headers: await auth(mailbox),
      signal: options.signal,
    });
    const rfc822MessageId = draft.internetMessageId ?? messageIdOf(parseHeaders(mime));
    if (!rfc822MessageId)
      throw new MailboxProviderError('graph', 'unknown', 'No Message-ID for the sent message');
    return {
      providerMessageId: draft.id,
      rfc822MessageId,
      ...(draft.conversationId ? { providerThreadId: draft.conversationId } : {}),
    };
  }

  /** Follows a delta chain to its end; returns the ids added and the new delta link. */
  private async delta(mailbox: MailboxCtx, start: string) {
    const added: { id: string; conversationId: string | null; receivedAt: string | null }[] = [];
    let url: string | undefined = start;
    let deltaLink: string | undefined;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      // Only the delta and next links Graph itself returned are followed (same host).
      if (!url.startsWith('https://graph.microsoft.com/'))
        throw new MailboxProviderError('graph', 'unknown', 'Unexpected delta link');
      const { body } = await providerFetch('graph', 'mailbox-api', url, {
        headers: { ...(await auth(mailbox)), prefer: 'odata.maxpagesize=50' },
      });
      const result = body as {
        value?: { id: string; conversationId?: string; receivedDateTime?: string; '@removed'?: unknown }[];
        '@odata.nextLink'?: string;
        '@odata.deltaLink'?: string;
      };
      for (const message of result.value ?? [])
        if (!message['@removed'])
          added.push({
            id: message.id,
            conversationId: message.conversationId ?? null,
            receivedAt: message.receivedDateTime ?? null,
          });
      url = result['@odata.nextLink'];
      deltaLink = result['@odata.deltaLink'] ?? deltaLink;
    }
    return { added, deltaLink };
  }

  async syncChanges(mailbox: MailboxCtx, cursor: SyncCursor | null) {
    const initial = `${API}/mailFolders/inbox/messages/delta?$select=id,conversationId,receivedDateTime`;
    if (!cursor || cursor.kind !== 'graph') {
      // First sync: walk to the current delta link without importing history.
      const { deltaLink } = await this.delta(mailbox, initial);
      return {
        messages: [] as RawInbound[],
        next: { kind: 'graph' as const, deltaLink: deltaLink ?? initial },
      };
    }
    const { added, deltaLink } = await this.delta(mailbox, cursor.deltaLink);
    const messages: RawInbound[] = [];
    for (const item of added) {
      const response = await fetchMime(mailbox, item.id);
      const headers = parseHeaders(response);
      messages.push({
        providerMessageId: item.id,
        providerThreadId: item.conversationId,
        rfc822MessageId: messageIdOf(headers),
        headers,
        raw: response,
        receivedAt: item.receivedAt ? new Date(item.receivedAt) : null,
      });
    }
    return { messages, next: { kind: 'graph' as const, deltaLink: deltaLink ?? cursor.deltaLink } };
  }

  async checkHealth(mailbox: MailboxCtx): Promise<HealthReport> {
    try {
      await providerFetch('graph', 'mailbox-api', `${API}?$select=mail`, { headers: await auth(mailbox) });
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

async function fetchMime(mailbox: MailboxCtx, id: string): Promise<Buffer> {
  const { body } = await providerFetch(
    'graph',
    'mailbox-api',
    `${API}/messages/${encodeURIComponent(id)}/$value`,
    {
      headers: await auth(mailbox),
    },
  );
  return Buffer.from(typeof body === 'string' ? body : '', 'utf8');
}
