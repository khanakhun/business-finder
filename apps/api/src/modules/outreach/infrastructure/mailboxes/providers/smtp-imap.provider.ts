import type { MailboxProviderState } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import { LOGGER, type Logger } from '../../../../platform/logging/logger.ts';
import {
  type HealthReport,
  MAILBOX_LIMITS,
  type MailboxCtx,
  type MailboxLimits,
  type MailboxProvider,
  type RawInbound,
  type SendResult,
  type SentProbe,
  type SmtpConnectionTester,
  type SyncCursor,
} from '../../../application/mailbox/ports.ts';
import { MailboxProviderError } from '../../../domain/mailbox/errors.ts';
import { addressesIn, messageIdOf, parseHeaders } from '../mime-headers.ts';

// Any SMTP + IMAP provider (BF-050), and Mailpit in development: send raw MIME over SMTP (TLS required — implicit or
// STARTTLS — except on the development hosts), keep a copy in Sent over IMAP when asked, and sync by UID since the
// last one seen (UIDVALIDITY change → start over from the newest). One connection per call, never pooled across
// mailboxes; the outbound queue runs one send per mailbox at a time.

type Endpoint = NonNullable<MailboxProviderState['smtp']>;

const CONNECT_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 60_000;
const SYNC_BATCH = 200;

function classify(error: unknown): MailboxProviderError {
  if (error instanceof MailboxProviderError) return error;
  const e = error as {
    code?: string;
    responseCode?: number;
    authenticationFailed?: boolean;
    message?: string;
  };
  if (e.authenticationFailed || e.code === 'EAUTH' || e.responseCode === 535)
    return new MailboxProviderError(
      'smtp_imap',
      'auth_failed',
      'The server refused the username or password',
      {
        cause: error,
      },
    );
  if (e.code === 'ETLS' || /STARTTLS|TLS/i.test(e.message ?? ''))
    return new MailboxProviderError(
      'smtp_imap',
      'tls_required',
      'A TLS connection could not be established',
      {
        cause: error,
      },
    );
  if (e.responseCode === 421 || e.responseCode === 450 || e.responseCode === 452)
    return new MailboxProviderError('smtp_imap', 'rate_limited', 'The server asked to slow down', {
      cause: error,
    });
  if (e.responseCode === 550 || e.responseCode === 554)
    return new MailboxProviderError('smtp_imap', 'rejected', 'The server rejected the message', {
      cause: error,
    });
  if (['ECONNECTION', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ESOCKET', 'EDNS'].includes(e.code ?? ''))
    return new MailboxProviderError('smtp_imap', 'unreachable', 'The server could not be reached', {
      cause: error,
    });
  return new MailboxProviderError('smtp_imap', 'unknown', 'The server call failed', { cause: error });
}

@Injectable()
export class SmtpImapProvider implements MailboxProvider, SmtpConnectionTester {
  readonly kind = 'smtp_imap' as const;
  readonly capabilities = { push: false, threads: false, rawMime: true } as const;

  constructor(
    @Inject(MAILBOX_LIMITS) private readonly limits: MailboxLimits,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private insecure(host: string) {
    return !this.limits.production && this.limits.insecureHosts.includes(host.toLowerCase());
  }

  private transport(endpoint: Endpoint, user: string, pass: string) {
    const insecure = this.insecure(endpoint.host);
    return createTransport({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.security === 'tls' && !insecure,
      requireTLS: endpoint.security === 'starttls' && !insecure,
      ignoreTLS: insecure,
      auth: { user, pass },
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      tls: { minVersion: 'TLSv1.2' },
    });
  }

  private imap(endpoint: Endpoint, user: string, pass: string) {
    const insecure = this.insecure(endpoint.host);
    return new ImapFlow({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.security === 'tls' && !insecure,
      doSTARTTLS: endpoint.security === 'starttls' && !insecure ? true : undefined,
      auth: { user, pass },
      logger: false,
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      tls: { minVersion: 'TLSv1.2' },
      disableAutoIdle: true,
    });
  }

  private async account(mailbox: MailboxCtx) {
    const credentials = await mailbox.credentials();
    const { smtp, imap } = mailbox.providerState;
    if (credentials.kind !== 'password' || !smtp)
      throw new MailboxProviderError('smtp_imap', 'auth_failed', 'The mailbox has no SMTP settings');
    return { smtp, imap, user: credentials.username, pass: credentials.password };
  }

  private async withImap<T>(
    endpoint: Endpoint,
    user: string,
    pass: string,
    fn: (client: ImapFlow) => Promise<T>,
  ) {
    const client = this.imap(endpoint, user, pass);
    try {
      await client.connect();
      return await fn(client);
    } catch (error) {
      throw classify(error);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  async sendRaw(
    mailbox: MailboxCtx,
    mime: Buffer,
    options: { readonly threadHint?: string; readonly signal: AbortSignal },
  ): Promise<SendResult> {
    const { smtp, imap, user, pass } = await this.account(mailbox);
    const headers = parseHeaders(mime);
    const rfc822MessageId = messageIdOf(headers);
    if (!rfc822MessageId)
      throw new MailboxProviderError('smtp_imap', 'rejected', 'The message has no Message-ID', {
        retryable: false,
      });
    const to = addressesIn([...(headers.to ?? []), ...(headers.cc ?? []), ...(headers.bcc ?? [])]);
    if (to.length === 0)
      throw new MailboxProviderError('smtp_imap', 'rejected', 'The message has no recipient', {
        retryable: false,
      });
    if (options.signal.aborted) throw new MailboxProviderError('smtp_imap', 'unreachable', 'Send aborted');
    const transport = this.transport(smtp, user, pass);
    const abort = () => transport.close();
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      const info = await transport.sendMail({ envelope: { from: mailbox.email, to }, raw: mime });
      if (imap && mailbox.providerState.appendToSent) {
        const folder = mailbox.providerState.sentFolder ?? 'Sent';
        // The copy in Sent is best effort: the message is already accepted.
        await this.withImap(imap, user, pass, (client) => client.append(folder, mime, ['\\Seen'])).catch(
          (error: unknown) =>
            this.logger.warn(
              { err: error, mailboxId: mailbox.id },
              'could not keep a copy in the Sent folder',
            ),
        );
      }
      return { providerMessageId: String(info.messageId ?? rfc822MessageId), rfc822MessageId };
    } catch (error) {
      throw classify(error);
    } finally {
      options.signal.removeEventListener('abort', abort);
      transport.close();
    }
  }

  /**
   * `SEARCH HEADER` in the Sent folder: our Message-ID, else our `X-BF-Outbound-Id`. Without IMAP (or without the copy
   * in Sent) the outcome cannot be known: that throws, and the pipeline does not resend.
   */
  async findSent(mailbox: MailboxCtx, probe: SentProbe, signal: AbortSignal): Promise<SendResult | null> {
    const { imap, user, pass } = await this.account(mailbox);
    if (!imap || !mailbox.providerState.appendToSent)
      throw new MailboxProviderError('smtp_imap', 'unknown', 'No Sent folder to check the send against', {
        retryable: false,
      });
    if (signal.aborted) throw new MailboxProviderError('smtp_imap', 'unreachable', 'Reconciliation aborted');
    const folder = mailbox.providerState.sentFolder ?? 'Sent';
    return this.withImap(imap, user, pass, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        for (const header of [
          { 'message-id': probe.rfc822MessageId },
          { 'x-bf-outbound-id': probe.outboundId },
        ]) {
          const uids = await client.search(
            { header, since: new Date(probe.since.getTime() - 86_400_000) },
            { uid: true },
          );
          if (uids && uids.length > 0)
            return { providerMessageId: probe.rfc822MessageId, rfc822MessageId: probe.rfc822MessageId };
        }
        return null;
      } finally {
        lock.release();
      }
    });
  }

  async syncChanges(mailbox: MailboxCtx, cursor: SyncCursor | null) {
    const { imap, user, pass } = await this.account(mailbox);
    // SMTP only (no IMAP configured): nothing to sync.
    if (!imap)
      return {
        messages: [] as RawInbound[],
        next: cursor ?? { kind: 'imap' as const, uidValidity: '0', lastUid: 0 },
      };
    return this.withImap(imap, user, pass, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const opened = client.mailbox;
        if (!opened) throw new MailboxProviderError('smtp_imap', 'unknown', 'INBOX could not be opened');
        const uidValidity = String(opened.uidValidity);
        const restart = !cursor || cursor.kind !== 'imap' || cursor.uidValidity !== uidValidity;
        // A first sync (or a reset mailbox) starts at the newest message: history is not imported.
        if (restart)
          return {
            messages: [] as RawInbound[],
            next: { kind: 'imap' as const, uidValidity, lastUid: Math.max(0, opened.uidNext - 1) },
          };
        const from = cursor.lastUid + 1;
        const messages: RawInbound[] = [];
        let lastUid = cursor.lastUid;
        if (opened.uidNext > from) {
          for await (const message of client.fetch(
            `${from}:*`,
            { uid: true, source: true, internalDate: true, threadId: true },
            { uid: true },
          )) {
            if (message.uid < from) continue;
            const source = message.source ?? null;
            const headers = source ? parseHeaders(source) : {};
            messages.push({
              providerMessageId: `${uidValidity}:${message.uid}`,
              providerThreadId: message.threadId ?? null,
              rfc822MessageId: messageIdOf(headers),
              headers,
              raw: source,
              receivedAt: message.internalDate ? new Date(message.internalDate) : null,
            });
            lastUid = Math.max(lastUid, message.uid);
            if (messages.length >= SYNC_BATCH) break;
          }
        }
        return { messages, next: { kind: 'imap' as const, uidValidity, lastUid } };
      } finally {
        lock.release();
      }
    });
  }

  async checkHealth(mailbox: MailboxCtx): Promise<HealthReport> {
    const { smtp, imap, user, pass } = await this.account(mailbox);
    const result = await this.test({ smtp, imap, username: user, password: pass });
    if (result.ok) return { tokenOk: true, reachable: true, quotaOk: true, error: null };
    return {
      tokenOk: result.reason !== 'auth_failed',
      reachable: result.reason !== 'unreachable',
      quotaOk: result.reason !== 'quota_exceeded',
      error: { code: result.reason, message: result.error },
    };
  }

  /** The live connection test: SMTP authentication, then IMAP login and the Sent folder's path. */
  async test(input: Parameters<SmtpConnectionTester['test']>[0]) {
    const transport = this.transport(input.smtp, input.username, input.password);
    try {
      await transport.verify();
    } catch (error) {
      const failure = classify(error);
      return { ok: false as const, error: `SMTP: ${failure.message}`, reason: failure.reason };
    } finally {
      transport.close();
    }
    const imap = input.imap;
    if (!imap) return { ok: true as const, sentFolder: null };
    try {
      const sentFolder = await this.withImap(imap, input.username, input.password, async (client) => {
        const boxes = await client.list();
        return boxes.find((box) => box.specialUse === '\\Sent')?.path ?? null;
      });
      return { ok: true as const, sentFolder };
    } catch (error) {
      const failure = classify(error);
      return { ok: false as const, error: `IMAP: ${failure.message}`, reason: failure.reason };
    }
  }
}
