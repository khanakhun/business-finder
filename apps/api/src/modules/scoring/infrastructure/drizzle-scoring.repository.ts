import {
  newId,
  type Offer,
  type ScoreTier,
  type ScoringProfileConfig,
  ScoringProfileConfigSchema,
} from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import {
  businessScoreHistory,
  businessScores,
  orgBusinesses,
  scoringProfiles,
  scoringProfileVersions,
  scoringWorkspaceSettings,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  ActiveProfile,
  ProfileRecord,
  ProfileVersionRecord,
  ScoreWrite,
  ScoringRepository,
  StoredScore,
} from '../application/ports.ts';

type ProfileRow = typeof scoringProfiles.$inferSelect;
type ScoreRow = typeof businessScores.$inferSelect;

const toProfile = (row: ProfileRow): ProfileRecord => ({
  id: row.id,
  organizationId: row.organizationId,
  offer: row.offer,
  name: row.name,
  builtin: row.builtin,
  activeVersion: row.activeVersion,
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
      .where(and(visibleTo(organizationId), isNotNull(scoringProfiles.activeVersion)))
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
  ): Promise<void> {
    const x = getExecutor(this.db);
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
      await x
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
        );
    }
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

  async writeScores(writes: readonly ScoreWrite[], primaryProfileId: string): Promise<void> {
    if (writes.length === 0) return;
    const x = getExecutor(this.db);
    const values = writes.map(scoreValues);
    await x
      .insert(businessScores)
      .values(values)
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
    await x.insert(businessScoreHistory).values(values.map((value) => ({ id: newId(), ...value })));
    const primary = writes.filter((write) => write.profileId === primaryProfileId);
    if (primary.length === 0) return;
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
