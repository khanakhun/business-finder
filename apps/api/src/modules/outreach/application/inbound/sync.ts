import type { Clock } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { MailboxesService } from '../mailbox/mailboxes.service.ts';
import { MAILBOX_REPOSITORY, type MailboxRepository, type SyncCursor } from '../mailbox/ports.ts';
import { inboundMetrics } from './inbound-metrics.ts';
import { ReplyIngestion } from './ingest.ts';
import {
  INBOUND_REPOSITORY,
  INBOUND_SETTINGS,
  type InboundRepository,
  type InboundSettings,
} from './ports.ts';

// One mailbox's sync (BF-054): the provider's changes since the stored cursor, each message ingested (or dropped by
// the privacy filter), then the cursor saved — after processing, so a crash re-reads rather than loses (ingestion is
// idempotent per provider message). Polling every `pollSeconds`; errors back off and are recorded for the health
// views (BF-053's guard, BF-056's dashboard).

const MAX_BACKOFF_MS = 30 * 60_000;

@Injectable()
export class MailboxSync {
  constructor(
    @Inject(INBOUND_REPOSITORY) private readonly inbound: InboundRepository,
    @Inject(MAILBOX_REPOSITORY) private readonly mailboxRepository: MailboxRepository,
    @Inject(INBOUND_SETTINGS) private readonly settings: InboundSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly mailboxes: MailboxesService,
    private readonly ingestion: ReplyIngestion,
  ) {}

  async sync(organizationId: string, mailboxId: string, logger: Logger) {
    const mailbox = await this.mailboxRepository.find(organizationId, mailboxId);
    if (!mailbox || mailbox.disconnectedAt) return { ingested: 0, ignored: 0 };
    const state = await this.inbound.syncState(mailboxId);
    const started = this.clock.now();
    try {
      const { messages, next } = await this.mailboxes
        .provider(mailbox)
        .syncChanges(this.mailboxes.ctx(mailbox), (state?.cursor as SyncCursor | null | undefined) ?? null);
      let ingested = 0;
      let ignored = 0;
      for (const message of messages) {
        const outcome = await this.ingestion.ingest(mailbox, message, logger);
        if (outcome === 'stored') ingested++;
        else if (outcome === 'ignored') ignored++;
      }
      const newest = messages
        .map((message) => message.receivedAt?.getTime() ?? 0)
        .reduce((a, b) => Math.max(a, b), 0);
      await this.inbound.saveSync(mailboxId, organizationId, {
        cursor: next as unknown as Record<string, unknown>,
        nextPollAt: new Date(started.getTime() + this.settings.pollSeconds * 1000),
        lastSuccessAt: this.clock.now(),
        lastError: null,
        consecutiveErrors: 0,
        lagSeconds: newest > 0 ? Math.round((this.clock.now().getTime() - newest) / 1000) : null,
        ingested,
        ignored,
      });
      inboundMetrics.syncs().inc({ provider: mailbox.provider, result: 'ok' });
      if (ingested > 0) logger.info({ mailboxId, ingested, ignored }, 'mailbox synced');
      return { ingested, ignored };
    } catch (error) {
      const errors = (state?.consecutiveErrors ?? 0) + 1;
      const backoff = Math.min(MAX_BACKOFF_MS, this.settings.pollSeconds * 1000 * 2 ** Math.min(errors, 6));
      await this.inbound.saveSync(mailboxId, organizationId, {
        nextPollAt: new Date(started.getTime() + backoff),
        lastErrorAt: this.clock.now(),
        lastError: error instanceof Error ? error.message.slice(0, 300) : 'sync failed',
        consecutiveErrors: errors,
      });
      inboundMetrics.syncs().inc({ provider: mailbox.provider, result: 'error' });
      // Authentication or quota problems move the mailbox (the person reconnects it).
      await this.mailboxes.recordProviderError(mailbox, error);
      logger.warn({ err: error, mailboxId, errors }, 'mailbox sync failed');
      return { ingested: 0, ignored: 0 };
    }
  }
}
