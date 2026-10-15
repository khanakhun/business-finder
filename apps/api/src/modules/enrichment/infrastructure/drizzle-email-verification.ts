import { createHash } from 'node:crypto';
import { type DbClient, getExecutor } from '@bf/db';
import { enrichmentEmailVerdicts } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { eq, lt, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  CachedVerdict,
  EmailSuppressionCheck,
  EmailVerdictCache,
  PersonalAddressPolicy,
} from '../application/ports.ts';

/** The cache key: the address is never stored in clear (retention, erasure). */
export const emailHash = (email: string) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/** Verdicts by address hash (`enrichment_email_verdicts`); a newer check is never replaced by an older one. */
@Injectable()
export class DrizzleEmailVerdictCache implements EmailVerdictCache {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async get(email: string): Promise<CachedVerdict | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(enrichmentEmailVerdicts)
      .where(eq(enrichmentEmailVerdicts.emailHash, emailHash(email)));
    if (!row) return undefined;
    return {
      check: { status: row.status, details: row.details, costUsd: row.costUsd },
      checkedAt: row.checkedAt,
      expiresAt: row.expiresAt,
      inconclusiveStreak: row.inconclusiveStreak,
    };
  }

  async put(email: string, verdict: CachedVerdict): Promise<void> {
    const values = {
      status: verdict.check.status,
      details: verdict.check.details,
      costUsd: verdict.check.costUsd,
      checkedAt: verdict.checkedAt,
      expiresAt: verdict.expiresAt,
      inconclusiveStreak: verdict.inconclusiveStreak,
    };
    await getExecutor(this.db)
      .insert(enrichmentEmailVerdicts)
      .values({ emailHash: emailHash(email), ...values })
      .onConflictDoUpdate({
        target: enrichmentEmailVerdicts.emailHash,
        set: values,
        setWhere: sql`excluded.checked_at >= ${enrichmentEmailVerdicts.checkedAt}`,
      });
  }

  async purgeExpired(before: Date): Promise<number> {
    const rows = await getExecutor(this.db)
      .delete(enrichmentEmailVerdicts)
      .where(lt(enrichmentEmailVerdicts.expiresAt, before))
      .returning({ emailHash: enrichmentEmailVerdicts.emailHash });
    return rows.length;
  }
}

/**
 * Until outreach suppression lists exist (BF-049), nothing is suppressed.
 * DECISION(BF-028): the port is checked before every verification; BF-049 binds the real lists (per workspace and
 * global objections) — the module warns at start-up in production while this no-op is bound.
 */
export class NoSuppression implements EmailSuppressionCheck {
  async isSuppressed(): Promise<boolean> {
    return false;
  }
}

/**
 * DECISION(BF-028): personal addresses may not be guessed anywhere until outreach compliance knows each business's
 * jurisdiction (BF-049): pattern guessing stays inert even with its workspace flag on.
 */
export class NoPersonalAddresses implements PersonalAddressPolicy {
  async allowsPersonalAddresses(): Promise<boolean> {
    return false;
  }
}
