import { type DbClient, getExecutor } from '@bf/db';
import { suppressionEntries, unsubscribeTokens } from '@bf/db/schema';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, count, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import { DsrService } from '../../application/dsr.service.ts';
import {
  type DataSubjectQuery,
  type PersonalDataProvider,
  PersonalDataRegistry,
} from '../../application/personal-data.ts';
import { UNSUBSCRIBE_TOKEN_REPOSITORY, type UnsubscribeTokenRepository } from '../../application/ports.ts';
import { RetentionRegistry } from '../../application/retention.ts';

// What the compliance module itself holds about people (BF-055): suppression entries in clear text (erasure deletes
// them — the keyed-hash entry added by the request keeps the person suppressed) and unsubscribe tokens (by keyed
// hash). Plus its retention policies: expired unsubscribe tokens, and access exports 30 days after completion.

const mask = (value: string) =>
  value.includes('@') ? `${value.slice(0, 1)}***@${value.split('@')[1]}` : '***';

@Injectable()
export class ComplianceSuppressionData implements PersonalDataProvider {
  readonly id = 'compliance.suppressions';
  readonly categories = ['contact_details', 'objection_records'] as const;

  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private keys(subject: DataSubjectQuery) {
    return [
      subject.email
        ? and(eq(suppressionEntries.scope, 'email'), eq(suppressionEntries.valueNormalized, subject.email))
        : undefined,
      subject.phone
        ? and(eq(suppressionEntries.scope, 'phone'), eq(suppressionEntries.valueNormalized, subject.phone))
        : undefined,
    ].filter((key) => key !== undefined);
  }

  async find(subject: DataSubjectQuery) {
    const keys = this.keys(subject);
    if (keys.length === 0) return [];
    const rows = await getExecutor(this.db)
      .select({
        id: suppressionEntries.id,
        scope: suppressionEntries.scope,
        value: suppressionEntries.valueNormalized,
        action: suppressionEntries.action,
      })
      .from(suppressionEntries)
      .where(and(eq(suppressionEntries.organizationId, subject.organizationId), or(...keys)));
    return rows.map((row) => ({ id: row.id, summary: `${row.action} ${row.scope} ${mask(row.value)}` }));
  }

  async export(_subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    const rows = await getExecutor(this.db)
      .select({
        scope: suppressionEntries.scope,
        value: suppressionEntries.valueNormalized,
        action: suppressionEntries.action,
        reason: suppressionEntries.reason,
        source: suppressionEntries.source,
        createdAt: suppressionEntries.createdAt,
      })
      .from(suppressionEntries)
      .where(
        inArray(
          suppressionEntries.id,
          refs.map((ref) => ref.id),
        ),
      );
    return [{ name: 'suppressions', rows }];
  }

  /** Deletes the clear-text entries (the append-only log allows it only under the retention flag). */
  async erase(subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    if (refs.length === 0) return { erased: 0, manual: 0 };
    const deleted = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('bf.retention', 'on', true)`);
      return tx
        .delete(suppressionEntries)
        .where(
          and(
            eq(suppressionEntries.organizationId, subject.organizationId),
            inArray(
              suppressionEntries.id,
              refs.map((ref) => ref.id),
            ),
          ),
        )
        .returning({ id: suppressionEntries.id });
    });
    return { erased: deleted.length, manual: 0 };
  }
}

@Injectable()
export class UnsubscribeTokenData implements PersonalDataProvider {
  readonly id = 'compliance.unsubscribe_tokens';
  readonly categories = ['contact_details'] as const;

  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async find(subject: DataSubjectQuery) {
    if (!subject.emailHash) return [];
    const rows = await getExecutor(this.db)
      .select({ id: unsubscribeTokens.id, createdAt: unsubscribeTokens.createdAt })
      .from(unsubscribeTokens)
      .where(
        and(
          eq(unsubscribeTokens.organizationId, subject.organizationId),
          eq(unsubscribeTokens.emailHash, subject.emailHash),
        ),
      );
    return rows.map((row) => ({
      id: row.id,
      summary: `unsubscribe link of ${row.createdAt.toISOString().slice(0, 10)}`,
    }));
  }

  async export(_subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    const rows = await getExecutor(this.db)
      .select({
        createdAt: unsubscribeTokens.createdAt,
        expiresAt: unsubscribeTokens.expiresAt,
        usedAt: unsubscribeTokens.usedAt,
        locale: unsubscribeTokens.locale,
      })
      .from(unsubscribeTokens)
      .where(
        inArray(
          unsubscribeTokens.id,
          refs.map((ref) => ref.id),
        ),
      );
    return [{ name: 'unsubscribe_links', rows }];
  }

  async erase(_subject: DataSubjectQuery, refs: readonly { id: string }[]) {
    if (refs.length === 0) return { erased: 0, manual: 0 };
    const deleted = await getExecutor(this.db)
      .delete(unsubscribeTokens)
      .where(
        inArray(
          unsubscribeTokens.id,
          refs.map((ref) => ref.id),
        ),
      )
      .returning({ id: unsubscribeTokens.id });
    return { erased: deleted.length, manual: 0 };
  }
}

/** Registers the compliance module's providers and retention policies. */
@Injectable()
export class ComplianceDataRegistrations implements OnModuleInit {
  constructor(
    private readonly personalData: PersonalDataRegistry,
    private readonly retention: RetentionRegistry,
    private readonly suppressions: ComplianceSuppressionData,
    private readonly tokens: UnsubscribeTokenData,
    private readonly dsr: DsrService,
    @Inject(UNSUBSCRIBE_TOKEN_REPOSITORY) private readonly tokenRepository: UnsubscribeTokenRepository,
    @Inject(DB_CLIENT) private readonly db: DbClient,
  ) {}

  onModuleInit() {
    this.personalData.register(this.suppressions);
    this.personalData.register(this.tokens);
    this.retention.register({
      id: 'compliance.unsubscribe_tokens',
      entity: 'unsubscribe_tokens',
      description: 'Unsubscribe links, two years after they were issued (at least 30 days are required).',
      retentionDays: 730,
      action: 'delete',
      count: async (now) => {
        const [row] = await this.db
          .select({ n: count() })
          .from(unsubscribeTokens)
          .where(lt(unsubscribeTokens.expiresAt, now));
        return Number(row?.n ?? 0);
      },
      apply: (now, limit) => this.tokenRepository.deleteExpired(now, limit),
    });
    this.retention.register({
      id: 'compliance.dsr_exports',
      entity: 'dsr_requests.export',
      description: 'Access-request exports, 30 days after the request was completed.',
      retentionDays: 30,
      action: 'delete',
      count: (now) => this.dsr.countExportsBefore(new Date(now.getTime() - 30 * 86_400_000)),
      apply: (now, limit) => this.dsr.purgeExports(new Date(now.getTime() - 30 * 86_400_000), limit),
    });
  }
}
