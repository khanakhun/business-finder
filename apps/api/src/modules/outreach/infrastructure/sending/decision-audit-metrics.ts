import { type DbClient, getExecutor } from '@bf/db';
import { metrics } from '@bf/observability';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import { LOGGER, type Logger } from '../../../platform/logging/logger.ts';

// The compliance audit as a metric (BF-061): messages that went out without their compliance decisions, and manual
// contacts without one. Check constraints already forbid both (BF-049, BF-052); this watches that no migration or
// manual fix ever weakens them. Any non-zero value pages. Worker only, every 10 minutes.

const SAMPLE_MS = 10 * 60_000;

const withoutDecision = () =>
  metrics.gauge({
    name: 'bf_compliance_sends_without_decision',
    help: 'Prospect messages sent (or contacts logged) without a compliance decision — must be 0',
    labelNames: ['kind'],
  });

@Injectable()
export class DecisionAuditSampler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.sample(), SAMPLE_MS);
    this.timer.unref();
    void this.sample();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sample(): Promise<void> {
    try {
      const [row] = await getExecutor(this.db).execute<{ email: number; manual: number }>(sql`
        SELECT
          (SELECT count(*) FROM outbound_messages
            WHERE status IN ('sent', 'bounced', 'replied')
              AND (send_decision_id IS NULL OR enqueue_decision_id IS NULL))::int AS email,
          (SELECT count(*) FROM manual_contact_logs WHERE decision_id IS NULL)::int AS manual`);
      withoutDecision().set({ kind: 'email' }, Number(row?.email ?? 0));
      withoutDecision().set({ kind: 'manual' }, Number(row?.manual ?? 0));
    } catch (error) {
      this.logger.warn({ err: error }, 'compliance audit sample failed');
    }
  }
}
