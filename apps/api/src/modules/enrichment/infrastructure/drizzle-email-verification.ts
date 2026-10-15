import { type DbClient, getExecutor } from '@bf/db';
import { businessContacts, emailVerificationCache } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  CachedVerdict,
  EmailContactReader,
  EmailContactView,
  EmailSuppressionCheck,
  EmailVerdictCache,
} from '../application/ports.ts';

/** Verdicts by address (`email_verification_cache`); the newest check replaces the previous one. */
@Injectable()
export class DrizzleEmailVerdictCache implements EmailVerdictCache {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async get(email: string): Promise<CachedVerdict | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(emailVerificationCache)
      .where(eq(emailVerificationCache.email, email));
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
      .insert(emailVerificationCache)
      .values({ email, ...values })
      .onConflictDoUpdate({ target: emailVerificationCache.email, set: values });
  }
}

/**
 * E-mail contacts as verification sees them.
 * DECISION(BF-027): read-only queries on business-graph tables (a cross-module read model); verdicts are written
 * through business-graph's `RecordEmailVerificationCommand`.
 */
@Injectable()
export class DrizzleEmailContactReader implements EmailContactReader {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async listForBusiness(businessId: string): Promise<EmailContactView[]> {
    const rows = await getExecutor(this.db)
      .select({
        id: businessContacts.id,
        businessId: businessContacts.businessId,
        email: businessContacts.normalizedValue,
        verificationStatus: businessContacts.verificationStatus,
        verifiedAt: businessContacts.verifiedAt,
      })
      .from(businessContacts)
      .where(and(eq(businessContacts.businessId, businessId), eq(businessContacts.type, 'email')))
      .orderBy(asc(businessContacts.firstSeenAt), asc(businessContacts.id));
    return rows;
  }

  async find(contactId: string): Promise<{ id: string; businessId: string; type: string } | undefined> {
    const [row] = await getExecutor(this.db)
      .select({
        id: businessContacts.id,
        businessId: businessContacts.businessId,
        type: businessContacts.type,
      })
      .from(businessContacts)
      .where(eq(businessContacts.id, contactId));
    return row;
  }

  async personNames(businessId: string): Promise<string[]> {
    const rows = await getExecutor(this.db)
      .selectDistinct({ name: businessContacts.personName })
      .from(businessContacts)
      .where(and(eq(businessContacts.businessId, businessId), isNotNull(businessContacts.personName)))
      .orderBy(sql`1`)
      .limit(5);
    return rows.flatMap((r) => (r.name ? [r.name] : []));
  }
}

/** Until outreach suppression lists exist (BF-049), nothing is suppressed. */
export class NoSuppression implements EmailSuppressionCheck {
  async isSuppressed(): Promise<boolean> {
    return false;
  }
}
