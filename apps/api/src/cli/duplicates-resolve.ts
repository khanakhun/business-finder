// pnpm duplicates:resolve [--apply]
// Merges the open possible duplicates that today's matcher would merge on sight (BF-016): pairs flagged before the
// `colocated` feature existed — the same name (similarity ≥ 0.95) within 25 m, from different sources, with no
// conflicting phone, website or same-provider evidence. Dry run by default: prints each pair, the survivor and why;
// `--apply` merges them through MergeBusinessesCommand (sources, contacts, media, reviews, workspace links and CRM
// state move to the survivor, which is recomputed from all its sources; the other becomes `merged_into`).
// The survivor is the richer record (website, phone, email, rating, opening hours, sources), so its id — the one
// already in lists, pipelines and links — is the one that stays.
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { MergeBusinessesRequestSchema, PERMISSIONS } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { NestFactory } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { AppModule } from '../app.module.ts';
import { MergeBusinessesCommand } from '../modules/business-graph/application/resolution/merge.commands.ts';
import { DEFAULT_THRESHOLDS } from '../modules/business-graph/domain/resolution/decision.ts';
import { DEFAULT_MATCH_WEIGHTS } from '../modules/business-graph/domain/resolution/match-scorer.ts';
import { loadAppEnv } from '../modules/platform/config/app-env.ts';
import { DB_CLIENT } from '../modules/platform/db/db.module.ts';
import type { AuthContext } from '../modules/platform/security/auth-context.ts';

const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });

type Pair = {
  id: string;
  a: string;
  b: string;
  score: number;
  name: number;
  meters: number;
  conflicts: string[];
};

type Richness = {
  id: string;
  display_name: string;
  website: boolean;
  phones: number;
  emails: number;
  rating: boolean;
  hours: number;
  sources: number;
  first_seen_at: string;
};

const richness = (r: Richness) =>
  (r.website ? 3 : 0) +
  Math.min(r.phones, 2) * 2 +
  Math.min(r.emails, 2) * 2 +
  (r.rating ? 1 : 0) +
  (r.hours > 0 ? 1 : 0) +
  r.sources;

const env = loadAppEnv('http');
const app = await NestFactory.createApplicationContext(AppModule.forHttp(env), { logger: ['error', 'warn'] });
try {
  const db = getExecutor(app.get<DbClient>(DB_CLIENT));
  // The explanation stored with each pair is the score's own features: the new rule is applied to it.
  const pairs = [
    ...(await db.execute<Pair>(sql`
      SELECT d.id::text, d.business_a_id::text AS a, d.business_b_id::text AS b, d.score,
        coalesce((SELECT (f->>'value')::float FROM jsonb_array_elements(d.reasons->'features') f
                  WHERE f->>'feature' = 'name'), 0) AS name,
        coalesce((SELECT (f->>'value')::float FROM jsonb_array_elements(d.reasons->'features') f
                  WHERE f->>'feature' = 'distance'), 1e9) AS meters,
        coalesce((SELECT array_agg(f->>'feature') FROM jsonb_array_elements(d.reasons->'features') f
                  WHERE f->>'feature' IN ('phoneConflict', 'websiteConflict', 'sameProvider')), '{}') AS conflicts
      FROM possible_duplicates d
      JOIN businesses a ON a.id = d.business_a_id AND a.merged_into_id IS NULL
      JOIN businesses b ON b.id = d.business_b_id AND b.merged_into_id IS NULL
      WHERE d.status = 'open'
      ORDER BY d.score DESC`)),
  ];

  const eligible = pairs.filter(
    (p) =>
      p.name >= 0.95 &&
      p.meters <= 25 &&
      p.conflicts.length === 0 &&
      p.score + DEFAULT_MATCH_WEIGHTS.colocated >= DEFAULT_THRESHOLDS.match,
  );
  console.log(`${pairs.length} open possible duplicates, ${eligible.length} to merge.`);

  const merge = app.get(MergeBusinessesCommand);
  const done = new Set<string>();
  let merged = 0;
  let skipped = 0;
  for (const pair of eligible) {
    // A business merged earlier in this run is gone: its other pairs were re-pointed to the survivor.
    if (done.has(pair.a) || done.has(pair.b)) continue;
    const rows = [
      ...(await db.execute<Richness>(sql`
        SELECT b.id::text, b.display_name, b.website_url IS NOT NULL AS website,
          (SELECT count(*)::int FROM business_contacts c WHERE c.business_id = b.id AND c.type = 'phone') AS phones,
          (SELECT count(*)::int FROM business_contacts c WHERE c.business_id = b.id AND c.type = 'email') AS emails,
          b.rating_avg IS NOT NULL AS rating,
          (SELECT count(*)::int FROM business_hours h WHERE h.business_id = b.id) AS hours,
          (SELECT count(*)::int FROM business_sources s WHERE s.business_id = b.id) AS sources,
          b.first_seen_at::text
        FROM businesses b WHERE b.id IN (${pair.a}::uuid, ${pair.b}::uuid)`)),
    ];
    // Different websites now (data changed since the pair was flagged): not the same place for sure.
    const sites = [
      ...(await db.execute<{ domain: string | null }>(sql`
        SELECT website_registrable_domain AS domain FROM businesses WHERE id IN (${pair.a}::uuid, ${pair.b}::uuid)`)),
    ].map((r) => r.domain);
    if (sites[0] && sites[1] && sites[0] !== sites[1]) {
      console.log(`skip  ${rows[0]?.display_name}: different websites (${sites.join(' / ')})`);
      skipped++;
      continue;
    }
    const [survivor, other] = [...rows].sort(
      (x, y) => richness(y) - richness(x) || x.first_seen_at.localeCompare(y.first_seen_at),
    );
    if (!survivor || !other) continue;
    // A workspace that tracks both (the merge acts as that workspace, as a platform operator: ADR-0008).
    const [org] = [
      ...(await db.execute<{ organization_id: string }>(sql`
        SELECT organization_id::text FROM org_businesses WHERE business_id = ${survivor.id}::uuid
        INTERSECT SELECT organization_id::text FROM org_businesses WHERE business_id = ${other.id}::uuid
        LIMIT 1`)),
    ];
    const line =
      `${survivor.display_name}: keep ${survivor.id} (richness ${richness(survivor)}), ` +
      `merge ${other.id} (richness ${richness(other)}) — score ${pair.score.toFixed(3)}, ` +
      `${pair.meters.toFixed(0)} m apart`;
    if (!org) {
      console.log(`skip  ${line}: no workspace tracks both`);
      skipped++;
      continue;
    }
    if (!values.apply) {
      console.log(`would ${line}`);
      continue;
    }
    const auth: AuthContext = {
      method: 'session',
      userId: null,
      apiKeyId: null,
      orgId: org.organization_id,
      role: 'owner',
      permissions: new Set(PERMISSIONS),
      crossOrigin: false,
      operator: true,
    };
    await merge.execute(
      auth,
      MergeBusinessesRequestSchema.parse({ survivorId: survivor.id, mergedIds: [other.id] }),
    );
    done.add(other.id);
    merged++;
    console.log(`merged ${line}`);
  }
  console.log(
    values.apply
      ? `duplicates:resolve: ${merged} merged, ${skipped} skipped.`
      : 'Dry run: nothing changed. Run with --apply to merge.',
  );
} finally {
  await app.close();
}
