import type { ComplianceDecision, OutreachChannel } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import {
  complianceDecisions,
  compliancePolicies,
  compliancePolicyReviews,
  lawfulBasisRecords,
  suppressionEntries,
  suppressionsCurrent,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  DecisionRepository,
  LawfulBasisRepository,
  PolicyRepository,
  StoredLawfulBasis,
  StoredPolicy,
  SuppressionFilter,
  SuppressionRepository,
} from '../application/ports.ts';

// Compliance storage (BF-049). Policy versions are immutable, so a version read once is cached in memory by id.

@Injectable()
export class DrizzlePolicyRepository implements PolicyRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  private async latest(
    organizationId: string | null,
    jurisdiction: string,
    channel: OutreachChannel,
    kind: 'seed' | 'override',
  ) {
    const [row] = await this.x
      .select()
      .from(compliancePolicies)
      .where(
        and(
          organizationId
            ? eq(compliancePolicies.organizationId, organizationId)
            : isNull(compliancePolicies.organizationId),
          eq(compliancePolicies.jurisdiction, jurisdiction),
          eq(compliancePolicies.channel, channel),
          eq(compliancePolicies.kind, kind),
        ),
      )
      .orderBy(desc(compliancePolicies.version))
      .limit(1);
    return row as StoredPolicy | undefined;
  }

  seed(jurisdiction: string, channel: OutreachChannel) {
    return this.latest(null, jurisdiction, channel, 'seed');
  }

  override(organizationId: string, jurisdiction: string, channel: OutreachChannel) {
    return this.latest(organizationId, jurisdiction, channel, 'override');
  }

  /** The newest version per (jurisdiction, channel) among the rows. */
  private heads(rows: StoredPolicy[]): StoredPolicy[] {
    const heads = new Map<string, StoredPolicy>();
    for (const row of rows) {
      const key = `${row.jurisdiction}/${row.channel}`;
      const current = heads.get(key);
      if (!current || row.version > current.version) heads.set(key, row);
    }
    return [...heads.values()];
  }

  async seeds() {
    return this.heads(
      (await this.x
        .select()
        .from(compliancePolicies)
        .where(
          and(isNull(compliancePolicies.organizationId), eq(compliancePolicies.kind, 'seed')),
        )) as StoredPolicy[],
    );
  }

  async overrides(organizationId: string) {
    return this.heads(
      (await this.x
        .select()
        .from(compliancePolicies)
        .where(
          and(eq(compliancePolicies.organizationId, organizationId), eq(compliancePolicies.kind, 'override')),
        )) as StoredPolicy[],
    );
  }

  async reviews(organizationId: string) {
    return this.x
      .select()
      .from(compliancePolicyReviews)
      .where(eq(compliancePolicyReviews.organizationId, organizationId));
  }

  async versions(organizationId: string, jurisdiction: string, channel: OutreachChannel) {
    return (await this.x
      .select()
      .from(compliancePolicies)
      .where(
        and(
          or(
            isNull(compliancePolicies.organizationId),
            eq(compliancePolicies.organizationId, organizationId),
          ),
          eq(compliancePolicies.jurisdiction, jurisdiction),
          eq(compliancePolicies.channel, channel),
        ),
      )
      .orderBy(desc(compliancePolicies.createdAt))) as StoredPolicy[];
  }

  async byId(organizationId: string, policyId: string) {
    const [row] = await this.x
      .select()
      .from(compliancePolicies)
      .where(
        and(
          eq(compliancePolicies.id, policyId),
          or(
            isNull(compliancePolicies.organizationId),
            eq(compliancePolicies.organizationId, organizationId),
          ),
        ),
      )
      .limit(1);
    return row as StoredPolicy | undefined;
  }

  async insertOverride(override: Parameters<PolicyRepository['insertOverride']>[0]) {
    const [last] = await this.x
      .select({ version: sql<number>`coalesce(max(${compliancePolicies.version}), 0)::int` })
      .from(compliancePolicies)
      .where(
        and(
          eq(compliancePolicies.organizationId, override.organizationId),
          eq(compliancePolicies.jurisdiction, override.jurisdiction),
          eq(compliancePolicies.channel, override.channel),
          eq(compliancePolicies.kind, 'override'),
        ),
      );
    const [row] = await this.x
      .insert(compliancePolicies)
      .values({
        organizationId: override.organizationId,
        jurisdiction: override.jurisdiction,
        channel: override.channel,
        version: (last?.version ?? 0) + 1,
        kind: 'override',
        rules: override.rules,
        sources: [],
        note: override.note,
        // A workspace's own override is its own decision: stricter only, no review needed.
        needsLegalReview: false,
        createdBy: override.createdBy,
      })
      .returning();
    return row as StoredPolicy;
  }

  async upsertReview(review: Parameters<PolicyRepository['upsertReview']>[0]) {
    const [row] = await this.x
      .insert(compliancePolicyReviews)
      .values(review)
      .onConflictDoUpdate({
        target: [compliancePolicyReviews.organizationId, compliancePolicyReviews.policyId],
        set: {
          reviewerName: review.reviewerName,
          notes: review.notes,
          autoSendEnabled: review.autoSendEnabled,
          reviewedBy: review.reviewedBy,
          reviewedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error('review not stored');
    return row;
  }

  async review(organizationId: string, policyId: string) {
    const [row] = await this.x
      .select()
      .from(compliancePolicyReviews)
      .where(
        and(
          eq(compliancePolicyReviews.organizationId, organizationId),
          eq(compliancePolicyReviews.policyId, policyId),
        ),
      )
      .limit(1);
    return row;
  }
}

@Injectable()
export class DrizzleDecisionRepository implements DecisionRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async insert(decision: Parameters<DecisionRepository['insert']>[0]) {
    const [row] = await this.x
      .insert(complianceDecisions)
      .values({ ...decision, alternatives: decision.alternatives as unknown[] })
      .returning({ id: complianceDecisions.id, evaluatedAt: complianceDecisions.evaluatedAt });
    if (!row) throw new Error('compliance decision not stored');
    return row;
  }

  async forBusiness(
    organizationId: string,
    businessId: string,
    limit: number,
  ): Promise<ComplianceDecision[]> {
    const rows = await this.x
      .select()
      .from(complianceDecisions)
      .where(
        and(
          eq(complianceDecisions.organizationId, organizationId),
          eq(complianceDecisions.businessId, businessId),
        ),
      )
      .orderBy(desc(complianceDecisions.evaluatedAt))
      .limit(limit);
    return rows.map(toDecision);
  }

  async byIds(organizationId: string, ids: readonly string[]): Promise<ComplianceDecision[]> {
    if (ids.length === 0) return [];
    const rows = await this.x
      .select()
      .from(complianceDecisions)
      .where(
        and(
          eq(complianceDecisions.organizationId, organizationId),
          inArray(complianceDecisions.id, [...ids]),
        ),
      );
    return rows.map(toDecision);
  }
}

function toDecision(row: typeof complianceDecisions.$inferSelect): ComplianceDecision {
  return {
    id: row.id,
    decision: row.decision,
    channel: row.channel,
    stage: row.stage,
    jurisdictions: row.jurisdictions,
    reasons: row.reasons,
    requiredElements: row.requiredElements,
    alternatives: row.alternatives as ComplianceDecision['alternatives'],
    policyVersionIds: row.policyVersionIds,
    autoSendPermitted: false,
    inputs: row.inputs,
    evaluatedAt: row.evaluatedAt.toISOString(),
    validUntil: row.validUntil?.toISOString() ?? null,
  };
}

@Injectable()
export class DrizzleSuppressionRepository implements SuppressionRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  private keyMatch(organizationId: string | null, scope: string, value: string) {
    return and(
      organizationId
        ? eq(suppressionsCurrent.organizationId, organizationId)
        : isNull(suppressionsCurrent.organizationId),
      eq(suppressionsCurrent.scope, scope as never),
      eq(suppressionsCurrent.valueNormalized, value),
    );
  }

  async add(entry: Parameters<SuppressionRepository['add']>[0]) {
    const [existing] = await this.x
      .select({ entryId: suppressionsCurrent.entryId })
      .from(suppressionsCurrent)
      .where(this.keyMatch(entry.organizationId, entry.scope, entry.value))
      .limit(1);
    if (existing) return { id: existing.entryId, created: false };
    const [row] = await this.x
      .insert(suppressionEntries)
      .values({
        organizationId: entry.organizationId,
        scope: entry.scope,
        valueNormalized: entry.value,
        action: 'add',
        reason: entry.reason,
        source: entry.source,
        actor: entry.actor,
        note: entry.note,
      })
      .returning({ id: suppressionEntries.id, createdAt: suppressionEntries.createdAt });
    if (!row) throw new Error('suppression not stored');
    await this.x
      .insert(suppressionsCurrent)
      .values({
        organizationId: entry.organizationId,
        scope: entry.scope,
        valueNormalized: entry.value,
        entryId: row.id,
        reason: entry.reason,
        createdAt: row.createdAt,
      })
      .onConflictDoNothing();
    return { id: row.id, created: true };
  }

  async revoke(entry: Parameters<SuppressionRepository['revoke']>[0]) {
    const removed = await this.x
      .delete(suppressionsCurrent)
      .where(this.keyMatch(entry.organizationId, entry.scope, entry.value))
      .returning({ entryId: suppressionsCurrent.entryId, reason: suppressionsCurrent.reason });
    if (removed.length === 0) return false;
    await this.x.insert(suppressionEntries).values({
      organizationId: entry.organizationId,
      scope: entry.scope,
      valueNormalized: entry.value,
      action: 'revoke',
      reason: removed[0]?.reason ?? 'manual',
      source: 'admin',
      actor: entry.actor,
      note: entry.note,
    });
    return true;
  }

  async find(organizationId: string, keys: Parameters<SuppressionRepository['find']>[1]) {
    if (keys.length === 0) return [];
    const rows = await this.x
      .select({
        scope: suppressionsCurrent.scope,
        value: suppressionsCurrent.valueNormalized,
        reason: suppressionsCurrent.reason,
        entryId: suppressionsCurrent.entryId,
      })
      .from(suppressionsCurrent)
      .where(
        and(
          or(
            eq(suppressionsCurrent.organizationId, organizationId),
            isNull(suppressionsCurrent.organizationId),
          ),
          or(
            ...keys.map((key) =>
              and(
                eq(suppressionsCurrent.scope, key.scope),
                eq(suppressionsCurrent.valueNormalized, key.value),
              ),
            ),
          ),
        ),
      );
    return rows;
  }

  async entry(organizationId: string, id: string) {
    const [row] = await this.x
      .select({
        scope: suppressionEntries.scope,
        value: suppressionEntries.valueNormalized,
        organizationId: suppressionEntries.organizationId,
      })
      .from(suppressionEntries)
      .where(
        and(
          eq(suppressionEntries.id, id),
          or(
            eq(suppressionEntries.organizationId, organizationId),
            isNull(suppressionEntries.organizationId),
          ),
        ),
      )
      .limit(1);
    return row;
  }

  async list(organizationId: string, page: { limit: number; before?: Date }) {
    const rows = await this.x
      .select()
      .from(suppressionEntries)
      .where(
        and(
          eq(suppressionEntries.organizationId, organizationId),
          page.before ? lt(suppressionEntries.createdAt, page.before) : undefined,
        ),
      )
      .orderBy(desc(suppressionEntries.createdAt))
      .limit(page.limit);
    return rows.map((row) => ({ ...row, value: row.valueNormalized }));
  }

  async searchLog(organizationId: string, filter: SuppressionFilter) {
    const rows = await this.x
      .select()
      .from(suppressionEntries)
      .where(
        and(
          eq(suppressionEntries.organizationId, organizationId),
          filter.q
            ? ilike(suppressionEntries.valueNormalized, `%${escapeLike(filter.q.toLowerCase())}%`)
            : undefined,
          filter.scope ? eq(suppressionEntries.scope, filter.scope) : undefined,
          filter.reason ? eq(suppressionEntries.reason, filter.reason) : undefined,
          filter.source ? eq(suppressionEntries.source, filter.source) : undefined,
          filter.from ? gte(suppressionEntries.createdAt, filter.from) : undefined,
          filter.to ? lte(suppressionEntries.createdAt, filter.to) : undefined,
          filter.before ? lt(suppressionEntries.createdAt, filter.before) : undefined,
        ),
      )
      .orderBy(desc(suppressionEntries.createdAt))
      .limit(filter.limit);
    return rows.map((row) => ({ ...row, value: row.valueNormalized }));
  }

  async searchCurrent(organizationId: string, filter: SuppressionFilter) {
    const rows = await this.x
      .select({
        entryId: suppressionsCurrent.entryId,
        scope: suppressionsCurrent.scope,
        value: suppressionsCurrent.valueNormalized,
        reason: suppressionsCurrent.reason,
        source: suppressionEntries.source,
        note: suppressionEntries.note,
        organizationId: suppressionsCurrent.organizationId,
        createdAt: suppressionsCurrent.createdAt,
      })
      .from(suppressionsCurrent)
      .innerJoin(suppressionEntries, eq(suppressionEntries.id, suppressionsCurrent.entryId))
      .where(
        and(
          or(
            eq(suppressionsCurrent.organizationId, organizationId),
            isNull(suppressionsCurrent.organizationId),
          ),
          filter.q
            ? ilike(suppressionsCurrent.valueNormalized, `%${escapeLike(filter.q.toLowerCase())}%`)
            : undefined,
          filter.scope ? eq(suppressionsCurrent.scope, filter.scope) : undefined,
          filter.reason ? eq(suppressionsCurrent.reason, filter.reason) : undefined,
          filter.source ? eq(suppressionEntries.source, filter.source) : undefined,
          filter.from ? gte(suppressionsCurrent.createdAt, filter.from) : undefined,
          filter.to ? lte(suppressionsCurrent.createdAt, filter.to) : undefined,
          filter.before ? lt(suppressionsCurrent.createdAt, filter.before) : undefined,
        ),
      )
      .orderBy(desc(suppressionsCurrent.createdAt))
      .limit(filter.limit);
    return rows.map(({ organizationId: owner, ...row }) => ({ ...row, global: owner === null }));
  }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

@Injectable()
export class DrizzleLawfulBasisRepository implements LawfulBasisRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async list(organizationId: string) {
    return (await this.x
      .select()
      .from(lawfulBasisRecords)
      .where(eq(lawfulBasisRecords.organizationId, organizationId))
      .orderBy(desc(lawfulBasisRecords.updatedAt))) as StoredLawfulBasis[];
  }

  async get(organizationId: string, id: string) {
    const [row] = await this.x
      .select()
      .from(lawfulBasisRecords)
      .where(and(eq(lawfulBasisRecords.organizationId, organizationId), eq(lawfulBasisRecords.id, id)))
      .limit(1);
    return row as StoredLawfulBasis | undefined;
  }

  async insert(record: Parameters<LawfulBasisRepository['insert']>[0]) {
    const [row] = await this.x.insert(lawfulBasisRecords).values(record).returning();
    return row as StoredLawfulBasis;
  }

  async update(organizationId: string, id: string, patch: Partial<StoredLawfulBasis>) {
    const { id: _id, organizationId: _org, createdAt: _created, ...set } = patch;
    const [row] = await this.x
      .update(lawfulBasisRecords)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(lawfulBasisRecords.organizationId, organizationId), eq(lawfulBasisRecords.id, id)))
      .returning();
    return row as StoredLawfulBasis | undefined;
  }
}
