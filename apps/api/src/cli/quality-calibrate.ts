// pnpm quality:calibrate golden [--limit 30]      Screenshots of the golden set + a ratings template (needs Docker)
// pnpm quality:calibrate agreement                  The critic on the golden set vs the team's ratings (needs keys)
// The visual critic's calibration (BF-045). `golden` builds the golden sites — every synthetic business of the eval
// set (apps/api/evals/blocks-engine), its starter site and a weakened variant (no photos, one dull palette) so the set
// spans strong to weak — renders each in the no-network sandbox and writes apps/api/evals/quality-golden/<id>/*.png
// with ratings.template.json. People fill ratings.json (1–5 per criterion and overall); `agreement` runs the critic on
// the same screenshots and writes the Spearman agreement per criterion, overall, and the threshold the data supports.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createAiGateway, QualityVisualCritic, VISUAL_CRITERIA, type VisualCriticOutput } from '@bf/ai';
import { aiEnv, generationEnv, loadEnvOrExit } from '@bf/config';
import { bestThreshold, spearman } from '../modules/generation/domain/quality/calibration.ts';
import {
  evalWorkspace,
  loadBusinesses,
} from '../modules/generation/infrastructure/engines/blocks/eval/harness.ts';
import { SandboxAuditClient } from '../modules/generation/infrastructure/quality/sandbox-audit.client.ts';
import { HttpDockerApi } from '../modules/generation/infrastructure/sandbox/docker-engine.ts';
import { DockerSandboxProvider } from '../modules/generation/infrastructure/sandbox/docker-sandbox.ts';
import { unpackBundle } from '../modules/generation/infrastructure/workspace/tar.ts';

const GOLDEN = new URL('../../evals/quality-golden/', import.meta.url);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { limit: { type: 'string', default: '30' } },
});
const env = loadEnvOrExit(aiEnv.extend(generationEnv.shape), { label: 'quality:calibrate' });

interface GoldenSite {
  readonly id: string;
  readonly business: string;
  readonly variant: 'starter' | 'weak';
  readonly shots: readonly {
    readonly page: string;
    readonly viewport: 'desktop' | 'mobile';
    readonly file: string;
  }[];
  readonly outline: { page: string; blocks: { id: string; type: string; variant: string }[] }[];
  readonly direction: { market: string; tone: string; style: string };
}

/** The weak variant: photos removed and the palette flattened to greys (a site people should rate low). */
function weaken(spec: Record<string, unknown>) {
  const site = structuredClone(spec) as { assets?: unknown[]; theme?: { palette?: Record<string, string> } };
  site.assets = [];
  if (site.theme?.palette)
    for (const key of Object.keys(site.theme.palette))
      site.theme.palette[key] = key === 'text' ? '#333333' : '#f2f2f2';
  return site;
}

async function golden(limit: number) {
  const client = new SandboxAuditClient(
    new DockerSandboxProvider(new HttpDockerApi(env.SANDBOX_DOCKER_HOST), { network: 'none' }),
    {
      image: env.SANDBOX_RUNNER_IMAGE,
      cpus: env.SANDBOX_CPUS,
      memoryMb: env.SANDBOX_MEMORY_MB,
      pidsLimit: env.SANDBOX_PIDS_LIMIT,
      wallTimeSec: 300,
    },
  );
  const sites: GoldenSite[] = [];
  for (const business of loadBusinesses()) {
    for (const variant of ['starter', 'weak'] as const) {
      if (sites.length >= limit) break;
      const workspace = evalWorkspace(business);
      const spec =
        variant === 'weak'
          ? weaken(workspace.starter as unknown as Record<string, unknown>)
          : workspace.starter;
      const run = await client.audit(unpackBundle(Buffer.from(workspace.bundle)), spec, {
        jobId: `golden-${business.id}`,
        organizationId: 'golden',
      });
      const id = `${business.id}--${variant}`;
      const dir = new URL(`${id}/`, GOLDEN);
      mkdirSync(dir, { recursive: true });
      const shots = (run.screenshots ?? []).flatMap((shot) => {
        const body = run.images.get(shot.file);
        if (!body) return [];
        const file = `${shot.page}.${shot.viewport}.png`;
        writeFileSync(new URL(file, dir), body);
        return [{ page: shot.page, viewport: shot.viewport, file: `${id}/${file}` }];
      });
      const site = spec as {
        pages: { id: string; blocks: { id: string; type: string; variant: string }[] }[];
        theme: { style?: string };
      };
      sites.push({
        id,
        business: business.businessName,
        variant,
        shots,
        outline: site.pages.map((page) => ({
          page: page.id,
          blocks: page.blocks.map(({ id: blockId, type, variant: v }) => ({ id: blockId, type, variant: v })),
        })),
        direction: {
          market: workspace.brief.audience.market,
          tone: workspace.brief.constraints.tone,
          style: String(site.theme.style ?? 'default'),
        },
      });
      console.log(`golden ${id}: ${shots.length} screenshot(s)`);
    }
  }
  writeFileSync(new URL('sites.json', GOLDEN), `${JSON.stringify(sites, null, 2)}\n`);
  const template = sites.map((site) => ({
    site: site.id,
    rater: '',
    overall: null,
    criteria: Object.fromEntries(VISUAL_CRITERIA.map((criterion) => [criterion, null])),
  }));
  writeFileSync(new URL('ratings.template.json', GOLDEN), `${JSON.stringify(template, null, 2)}\n`);
  console.log(
    `${sites.length} golden sites; copy ratings.template.json to ratings.json and rate each site (1–5).`,
  );
}

async function agreement() {
  const sites = JSON.parse(readFileSync(new URL('sites.json', GOLDEN), 'utf8')) as GoldenSite[];
  const ratings = JSON.parse(readFileSync(new URL('ratings.json', GOLDEN), 'utf8')) as {
    site: string;
    overall: number | null;
    criteria: Record<string, number | null>;
  }[];
  const gateway = createAiGateway({
    routing: {
      tiers: { fast: env.AI_MODEL_FAST, smart: env.AI_MODEL_SMART, agent: env.AI_MODEL_AGENT },
      overrides: env.AI_MODEL_OVERRIDES,
      fallbacks: env.AI_MODEL_FALLBACKS,
      embeddingModel: env.AI_EMBEDDING_MODEL,
    },
    keys: {
      resolve: async (_org, provider) =>
        provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY,
    },
    pricing: env.AI_PRICING,
  });
  const rows: { site: string; critic: Record<string, number>; human: (typeof ratings)[number] }[] = [];
  let cost = 0;
  for (const site of sites) {
    const human = ratings.find((rating) => rating.site === site.id && rating.overall !== null);
    if (!human) continue;
    const result = await gateway.vision(
      QualityVisualCritic,
      {
        input: {
          business: { name: site.business, category: null },
          direction: site.direction,
          outline: site.outline,
          screenshots: site.shots.map((shot) => `${shot.page}, ${shot.viewport}`),
        },
        images: site.shots.map((shot) => ({
          bytes: readFileSync(new URL(shot.file, GOLDEN)),
          mediaType: 'image/png',
        })),
      },
      { orgId: null },
    );
    cost += result.costUsd ?? 0;
    const output = result.output as VisualCriticOutput;
    rows.push({
      site: site.id,
      critic: Object.fromEntries(output.criteria.map((c) => [c.criterion, c.score])),
      human,
    });
  }
  const average = (scores: Record<string, number>) =>
    VISUAL_CRITERIA.reduce((sum, c) => sum + (scores[c] ?? 0), 0) / VISUAL_CRITERIA.length;
  const perCriterion = Object.fromEntries(
    VISUAL_CRITERIA.map((criterion) => {
      const pairs = rows.filter((row) => typeof row.human.criteria[criterion] === 'number');
      return [
        criterion,
        spearman(
          pairs.map((row) => row.critic[criterion] ?? 0),
          pairs.map((row) => row.human.criteria[criterion] as number),
        ),
      ];
    }),
  );
  const overall = spearman(
    rows.map((row) => average(row.critic)),
    rows.map((row) => row.human.overall as number),
  );
  const threshold = bestThreshold(
    rows.map((row) => ({ critic: average(row.critic), human: row.human.overall as number })),
  );
  const report = {
    sites: rows.length,
    costUsd: cost,
    overall,
    perCriterion,
    threshold,
    target: { overall: 0.6 },
  };
  writeFileSync(
    new URL(`agreement-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, GOLDEN),
    `${JSON.stringify({ ...report, rows }, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = overall !== null && overall >= 0.6 ? 0 : 1;
}

if (positionals[0] === 'golden') await golden(Number(values.limit));
else if (positionals[0] === 'agreement') await agreement();
else {
  console.error('Usage: pnpm quality:calibrate golden [--limit 30] | agreement');
  process.exitCode = 2;
}
