import {
  newId,
  type Offer,
  type ScoreTier,
  type ScoringProfileConfig,
  ScoringProfileConfigSchema,
} from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import {
  businesses,
  businessScoreHistory,
  businessScores,
  orgBusinesses,
  scoringProfiles,
  scoringProfileVersions,
  scoringWorkspaceSettings,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  ActiveProfile,
  ProfileRecord,
  ProfileVersionRecord,
  ScoreWrite,
  ScoreWriteRequest,
  ScoringRepository,
  StoredScore,
} from '../application/ports.ts';

type ProfileRow = typeof scoringProfiles.$inferSelect;

/** Rows per insert statement. */
const WRITE_CHUNK = 2_000;
type ScoreRow = typeof businessScores.$inferSelect;

const toProfile = (row: ProfileRow): ProfileRecord => ({
  id: row.id,
  organizationId: row.organizationId,
  offer: row.offer,
  name: row.name,
  builtin: row.builtin,
  activeVersion: row.activeVersion,
  archived: row.archivedAt !== null,
});

const toScore = (row: ScoreRow): StoredScore => ({
  organizationId: row.organizationId,
  businessId: row.businessId,
  profileId: row.profileId,
  profileVersion: row.profileVersion,
  score: row.score,
  tier: row.tier,
  contributions: row.contributions,
  reasons: row.reasons,
  gated: row.gated ?? null,
  features: row.features,
  featureSetVersion: row.featureSetVersion,
  factsHash: row.factsHash,
  computedAt: row.computedAt,
});

/** Profiles a workspace sees: the built-ins and its own. */
const visibleTo = (organizationId: string) =>
  or(isNull(scoringProfiles.organizationId), eq(scoringProfiles.organizationId, organizationId));

const scoreValues = (write: ScoreWrite) => ({
  organizationId: write.organizationId,
  businessId: write.businessId,
  profileId: write.profileId,
  profileVersion: write.profileVersion,
  score: write.score,
  tier: write.tier,
  contributions: write.contributions,
  reasons: write.reasons,
  gated: write.gated,
  features: write.features,
  featureSetVersion: write.featureSetVersion,
  factsHash: write.factsHash,
  computedAt: write.computedAt,
});

@Injectable()
export class DrizzleScoringRepository implements ScoringRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async activeProfiles(organizationId: string): Promise<ActiveProfile[]> {
    const rows = await getExecutor(this.db)
      .select({ profile: scoringProfiles, config: scoringProfileVersions.config })
      .from(scoringProfiles)
      .innerJoin(
        scoringProfileVersions,
        and(
          eq(scoringProfileVersions.profileId, scoringProfiles.id),
          eq(scoringProfileVersions.version, scoringProfiles.activeVersion),
        ),
      )
      .where(
        and(
          visibleTo(organizationId),
          isNotNull(scoringProfiles.activeVersion),
          isNull(scoringProfiles.archivedAt),
        ),
      )
      .orderBy(asc(scoringProfiles.builtin), asc(scoringProfiles.offer), asc(scoringProfiles.id));
    return rows.map(({ profile, config }) => ({
      ...toProfile(profile),
      activeVersion: profile.activeVersion as number,
      // Stored configs were validated when written; parsing applies defaults added since.
      config: ScoringProfileConfigSchema.parse(config),
    }));
  }

  async profiles(organizationId: string): Promise<ProfileRecord[]> {
    const rows = await getExecutor(this.db)
      .select()
      .from(scoringProfiles)
      .where(visibleTo(organizationId))
      .orderBy(asc(scoringProfiles.offer), asc(scoringProfiles.builtin), asc(scoringProfiles.name));
    return rows.map(toProfile);
  }

  async profile(organizationId: string, profileId: string): Promise<ProfileRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(scoringProfiles)
      .where(and(eq(scoringProfiles.id, profileId), visibleTo(organizationId)));
    return row ? toProfile(row) : undefined;
  }

  async lockProfile(
    organizationId: string,
    profileId: string,
    mode: 'update' | 'share',
  ): Promise<ProfileRecord | undefined> {
    const query = getExecutor(this.db)
      .select()
      .from(scoringProfiles)
      .where(and(eq(scoringProfiles.id, profileId), visibleTo(organizationId)));
    const [row] = await (mode === 'update' ? query.for('update') : query.for('share'));
    return row ? toProfile(row) : undefined;
  }

  async countOwnProfiles(organizationId: string): Promise<number> {
    const [row] = await getExecutor(this.db)
      .select({ n: count() })
      .from(scoringProfiles)
      .where(eq(scoringProfiles.organizationId, organizationId));
    return row?.n ?? 0;
  }

  async version(profileId: string, version: number): Promise<ProfileVersionRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(scoringProfileVersions)
      .where(
        and(eq(scoringProfileVersions.profileId, profileId), eq(scoringProfileVersions.version, version)),
      );
    return row
      ? {
          profileId: row.profileId,
          version: row.version,
          config: ScoringProfileConfigSchema.parse(row.config),
          createdAt: row.createdAt,
        }
      : undefined;
  }

  async ensureBuiltins(
    profiles: readonly {
      id: string;
      offer: Offer;
      name: string;
      version: number;
      config: ScoringProfileConfig;
    }[],
  ): Promise<{ readonly profileId: string; readonly version: number }[]> {
    const x = getExecutor(this.db);
    const activated: { profileId: string; version: number }[] = [];
    for (const profile of profiles) {
      await x
        .insert(scoringProfiles)
        .values({
          id: profile.id,
          organizationId: null,
          offer: profile.offer,
          name: profile.name,
          builtin: true,
        })
        .onConflictDoNothing({ target: scoringProfiles.id });
      await x
        .insert(scoringProfileVersions)
        .values({ profileId: profile.id, version: profile.version, config: profile.config })
        .onConflictDoNothing();
      // A newer built-in version becomes active; an older process never moves it back.
      const moved = await x
        .update(scoringProfiles)
        .set({ activeVersion: profile.version })
        .where(
          and(
            eq(scoringProfiles.id, profile.id),
            or(
              isNull(scoringProfiles.activeVersion),
              sql`${scoringProfiles.activeVersion} < ${profile.version}`,
            ),
          ),
        )
        .returning({ id: scoringProfiles.id });
      if (moved.length > 0) activated.push({ profileId: profile.id, version: profile.version });
    }
    return activated;
  }

  async workspacesWithBusinesses(): Promise<string[]> {
    const rows = await getExecutor(this.db)
      .selectDistinct({ organizationId: orgBusinesses.organizationId })
      .from(orgBusinesses);
    return rows.map((row) => row.organizationId);
  }

  async createProfile(input: Parameters<ScoringRepository['createProfile']>[0]): Promise<ProfileRecord> {
    const x = getExecutor(this.db);
    const [row] = await x
      .insert(scoringProfiles)
      .values({
        organizationId: input.organizationId,
        offer: input.offer,
        name: input.name,
        builtin: false,
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) throw new Error('scoring profile insert returned no row');
    await x
      .insert(scoringProfileVersions)
      .values({ profileId: row.id, version: 1, config: input.config, createdBy: input.createdBy });
    await x.update(scoringProfiles).set({ activeVersion: 1 }).where(eq(scoringProfiles.id, row.id));
    return { ...toProfile(row), activeVersion: 1 };
  }

  async updateProfile(
    organizationId: string,
    profileId: string,
    change: { name?: string; archivedAt?: Date | null },
  ): Promise<void> {
    await getExecutor(this.db)
      .update(scoringProfiles)
      .set({
        ...(change.name !== undefined ? { name: change.name } : {}),
        ...(change.archivedAt !== undefined ? { archivedAt: change.archivedAt } : {}),
      })
      .where(and(eq(scoringProfiles.id, profileId), eq(scoringProfiles.organizationId, organizationId)));
  }

  async versions(organizationId: string, profileId: string): Promise<{ version: number; createdAt: Date }[]> {
    return getExecutor(this.db)
      .select({ version: scoringProfileVersions.version, createdAt: scoringProfileVersions.createdAt })
      .from(scoringProfileVersions)
      .innerJoin(scoringProfiles, eq(scoringProfiles.id, scoringProfileVersions.profileId))
      .where(and(eq(scoringProfileVersions.profileId, profileId), visibleTo(organizationId)))
      .orderBy(desc(scoringProfileVersions.version));
  }

  async addVersion(
    organizationId: string,
    profileId: string,
    config: ScoringProfileConfig,
    createdBy: string | null,
  ): Promise<number> {
    const x = getExecutor(this.db);
    // The profile row is the lock (taken again here, a no-op under the caller's): two saves never share a number.
    const [own] = await x
      .select({ id: scoringProfiles.id })
      .from(scoringProfiles)
      .where(and(eq(scoringProfiles.id, profileId), eq(scoringProfiles.organizationId, organizationId)))
      .for('update');
    if (!own) throw new Error(`scoring profile ${profileId} is not the workspace's own`);
    const [row] = await x
      .select({ last: sql<number>`coalesce(max(${scoringProfileVersions.version}), 0)::int` })
      .from(scoringProfileVersions)
      .where(eq(scoringProfileVersions.profileId, profileId));
    const version = (row?.last ?? 0) + 1;
    await x.insert(scoringProfileVersions).values({ profileId, version, config, createdBy });
    return version;
  }

  async activate(organizationId: string, profileId: string, version: number): Promise<void> {
    await getExecutor(this.db)
      .update(scoringProfiles)
      .set({ activeVersion: version })
      .where(and(eq(scoringProfiles.id, profileId), eq(scoringProfiles.organizationId, organizationId)));
  }

  async previewSample(organizationId: string, profileId: string, size: number) {
    // Round-robin over the tiers (and the not-yet-scored), each in a stable pseudo-random order: every tier is
    // represented as evenly as the workspace allows, up to `size`.
    const rows = await getExecutor(this.db).execute<{
      business_id: string;
      display_name: string;
      score: number | null;
      tier: ScoreTier | null;
    }>(sql`
      SELECT business_id, display_name, score, tier FROM (
        SELECT ob.business_id, b.display_name, bs.score, bs.tier,
          row_number() OVER (PARTITION BY coalesce(bs.tier, '-') ORDER BY md5(ob.business_id::text)) AS n
        FROM ${orgBusinesses} ob
        JOIN ${businesses} b ON b.id = ob.business_id
        LEFT JOIN ${businessScores} bs ON bs.organization_id = ob.organization_id
          AND bs.business_id = ob.business_id AND bs.profile_id = ${profileId}
        WHERE ob.organization_id = ${organizationId} AND b.merged_into_id IS NULL
      ) sampled
      ORDER BY n, coalesce(tier, '-')
      LIMIT ${size}`);
    return rows.map((row) => ({
      businessId: row.business_id,
      displayName: row.display_name,
      score: row.score,
      tier: row.tier,
    }));
  }

  async primaryProfileId(organizationId: string): Promise<string | null> {
    const [row] = await getExecutor(this.db)
      .select({ id: scoringWorkspaceSettings.primaryProfileId })
      .from(scoringWorkspaceSettings)
      .where(eq(scoringWorkspaceSettings.organizationId, organizationId));
    return row?.id ?? null;
  }

  async setPrimaryProfile(organizationId: string, profileId: string, userId: string | null): Promise<void> {
    await getExecutor(this.db)
      .insert(scoringWorkspaceSettings)
      .values({ organizationId, primaryProfileId: profileId, updatedBy: userId })
      .onConflictDoUpdate({
        target: scoringWorkspaceSettings.organizationId,
        set: { primaryProfileId: profileId, updatedBy: userId },
      });
  }

  async databaseNow(): Promise<Date> {
    const [row] = await getExecutor(this.db).execute<{ now: Date | string }>(sql`SELECT now() AS now`);
    if (!row) throw new Error('SELECT now() returned no row');
    return new Date(row.now);
  }

  async lockBusinesses(organizationId: string, businessIds: readonly string[]): Promise<Set<string>> {
    if (businessIds.length === 0) return new Set();
    // Row locks on the workspace's rows (no shared lock-table entries), in id order: concurrent batches never wait
    // on each other in a cycle, and the listing columns updated later in the transaction are already ours.
    const rows = await getExecutor(this.db).execute<{ business_id: string }>(sql`
      SELECT business_id FROM ${orgBusinesses}
      WHERE organization_id = ${organizationId}
        AND business_id = ANY(${sql`ARRAY[${sql.join(
          businessIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]`})
      ORDER BY business_id
      FOR NO KEY UPDATE`);
    return new Set(rows.map((row) => row.business_id));
  }

  async activeVersions(profileIds: readonly string[]): Promise<Map<string, number>> {
    if (profileIds.length === 0) return new Map();
    const rows = await getExecutor(this.db)
      .select({ id: scoringProfiles.id, version: scoringProfiles.activeVersion })
      .from(scoringProfiles)
      .where(inArray(scoringProfiles.id, [...profileIds]));
    return new Map(rows.flatMap((row) => (row.version === null ? [] : [[row.id, row.version] as const])));
  }

  async currentScores(organizationId: string, businessIds: readonly string[]) {
    const current = new Map<
      string,
      {
        profileId: string;
        profileVersion: number;
        featureSetVersion: number;
        factsHash: string;
        score: number;
        tier: ScoreTier;
        computedAt: Date;
      }[]
    >();
    if (businessIds.length === 0) return current;
    const rows = await getExecutor(this.db)
      .select({
        businessId: businessScores.businessId,
        profileId: businessScores.profileId,
        profileVersion: businessScores.profileVersion,
        featureSetVersion: businessScores.featureSetVersion,
        factsHash: businessScores.factsHash,
        score: businessScores.score,
        tier: businessScores.tier,
        computedAt: businessScores.computedAt,
      })
      .from(businessScores)
      .where(
        and(
          eq(businessScores.organizationId, organizationId),
          inArray(businessScores.businessId, [...businessIds]),
        ),
      );
    for (const { businessId, ...score } of rows)
      current.set(businessId, [...(current.get(businessId) ?? []), score]);
    return current;
  }

  async writeScores(writes: readonly ScoreWriteRequest[], primaryProfileId: string): Promise<void> {
    if (writes.length === 0) return;
    const x = getExecutor(this.db);
    // Chunks stay under Postgres's 65,535 bind parameters (14 columns a row).
    for (let start = 0; start < writes.length; start += WRITE_CHUNK) {
      const chunk = writes.slice(start, start + WRITE_CHUNK);
      await x
        .insert(businessScores)
        .values(chunk.map(scoreValues))
        .onConflictDoUpdate({
          target: [businessScores.organizationId, businessScores.businessId, businessScores.profileId],
          set: {
            profileVersion: sql`excluded.profile_version`,
            score: sql`excluded.score`,
            tier: sql`excluded.tier`,
            contributions: sql`excluded.contributions`,
            reasons: sql`excluded.reasons`,
            gated: sql`excluded.gated`,
            features: sql`excluded.features`,
            featureSetVersion: sql`excluded.feature_set_version`,
            factsHash: sql`excluded.facts_hash`,
            computedAt: sql`excluded.computed_at`,
          },
        });
      const history = chunk.filter((write) => write.history).map(scoreValues);
      if (history.length > 0) {
        await x.insert(businessScoreHistory).values(history.map((value) => ({ id: newId(), ...value })));
      }
    }
    const primary = writes.filter((write) => write.profileId === primaryProfileId);
    if (primary.length === 0) return;
    // DECISION(BF-031): scoring keeps the CRM's denormalized listing columns (BF-022) for the primary profile.
    const rows = sql.join(
      primary.map(
        (write) =>
          sql`(${write.organizationId}::uuid, ${write.businessId}::uuid, ${write.score}::smallint, ${write.tier})`,
      ),
      sql`, `,
    );
    await x.execute(sql`
      UPDATE ${orgBusinesses} ob SET score = v.score, tier = v.tier, score_profile_id = ${primaryProfileId}::uuid
      FROM (VALUES ${rows}) AS v(organization_id, business_id, score, tier)
      WHERE ob.organization_id = v.organization_id AND ob.business_id = v.business_id`);
  }

  async denormalizePrimary(organizationId: string, primaryProfileId: string): Promise<void> {
    // The workspace's rows in id order first, as scoring batches lock them (no deadlock with a running batch).
    await getExecutor(this.db).execute(sql`
      SELECT 1 FROM ${orgBusinesses} WHERE organization_id = ${organizationId}
      ORDER BY business_id FOR NO KEY UPDATE`);
    await getExecutor(this.db).execute(sql`
      UPDATE ${orgBusinesses} ob
      SET score = bs.score, tier = bs.tier, score_profile_id = CASE WHEN bs.score IS NULL THEN NULL ELSE bs.profile_id END
      FROM ${orgBusinesses} o
      LEFT JOIN ${businessScores} bs ON bs.organization_id = o.organization_id AND bs.business_id = o.business_id
        AND bs.profile_id = ${primaryProfileId}
      WHERE o.organization_id = ${organizationId} AND ob.organization_id = o.organization_id
        AND ob.business_id = o.business_id
        AND (ob.score IS DISTINCT FROM bs.score OR ob.tier IS DISTINCT FROM bs.tier
          OR ob.score_profile_id IS DISTINCT FROM bs.profile_id)`);
  }

  async businessScores(organizationId: string, businessId: string): Promise<StoredScore[]> {
    const rows = await getExecutor(this.db)
      .select()
      .from(businessScores)
      .where(
        and(eq(businessScores.organizationId, organizationId), eq(businessScores.businessId, businessId)),
      )
      .orderBy(asc(businessScores.profileId));
    return rows.map(toScore);
  }

  async tracks(organizationId: string, businessId: string): Promise<boolean> {
    const [row] = await getExecutor(this.db)
      .select({ businessId: orgBusinesses.businessId })
      .from(orgBusinesses)
      .where(and(eq(orgBusinesses.organizationId, organizationId), eq(orgBusinesses.businessId, businessId)));
    return row !== undefined;
  }

  async trackedByRun(organizationId: string, runId: string): Promise<string[]> {
    const rows = await getExecutor(this.db)
      .select({ businessId: orgBusinesses.businessId })
      .from(orgBusinesses)
      .where(
        and(
          eq(orgBusinesses.organizationId, organizationId),
          eq(orgBusinesses.addedVia, 'discovery'),
          eq(orgBusinesses.addedRef, runId),
        ),
      );
    return rows.map((row) => row.businessId);
  }

  async trackedPage(organizationId: string, after: string | null, limit: number): Promise<string[]> {
    const rows = await getExecutor(this.db)
      .select({ businessId: orgBusinesses.businessId })
      .from(orgBusinesses)
      .where(
        and(
          eq(orgBusinesses.organizationId, organizationId),
          after ? gt(orgBusinesses.businessId, after) : undefined,
        ),
      )
      .orderBy(asc(orgBusinesses.businessId))
      .limit(limit);
    return rows.map((row) => row.businessId);
  }

  async trackedCount(organizationId: string): Promise<number> {
    const [row] = await getExecutor(this.db)
      .select({ n: count() })
      .from(orgBusinesses)
      .where(eq(orgBusinesses.organizationId, organizationId));
    return row?.n ?? 0;
  }

  async workspacesTracking(businessIds: readonly string[]): Promise<Map<string, string[]>> {
    const byOrg = new Map<string, string[]>();
    if (businessIds.length === 0) return byOrg;
    const rows = await getExecutor(this.db)
      .select({ organizationId: orgBusinesses.organizationId, businessId: orgBusinesses.businessId })
      .from(orgBusinesses)
      .where(inArray(orgBusinesses.businessId, [...businessIds]));
    for (const row of rows)
      byOrg.set(row.organizationId, [...(byOrg.get(row.organizationId) ?? []), row.businessId]);
    return byOrg;
  }
}
