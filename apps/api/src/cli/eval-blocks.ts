// pnpm --filter @bf/api eval:blocks [--limit <n>] [--only <id,id>] [--no-judge] [--simulated] [--concurrency <n>]
// The blocks engine's eval (BF-041) on the synthetic businesses of apps/api/evals/blocks-engine/businesses.json.
//   default: real models through the AI gateway (ANTHROPIC_API_KEY / OPENAI_API_KEY; costs money), each site graded by
//   the agent-tier judge (generation.site_judge, blind to the engine). --simulated: the CI model, no network.
// Writes apps/api/evals/blocks-engine/reports/<timestamp>.{md,json}; exits 1 below the ticket's thresholds.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { type AiGateway, createAiGateway, GenerationSiteJudge, SITE_JUDGE_CRITERIA } from '@bf/ai';
import { aiEnv, loadEnvOrExit } from '@bf/config';
import {
  DATASET,
  evalWorkspace,
  loadBusinesses,
  type RowReport,
  reportMarkdown,
  rowReport,
  runEngine,
  siteTexts,
  summarize,
  thresholdFailures,
} from '../modules/generation/infrastructure/engines/blocks/eval/harness.ts';
import { simulatedGateway } from '../modules/generation/infrastructure/engines/blocks/eval/simulated-model.ts';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    limit: { type: 'string' },
    only: { type: 'string' },
    'no-judge': { type: 'boolean', default: false },
    simulated: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '3' },
  },
});

let gateway: AiGateway;
let model = 'simulated';
if (values.simulated) gateway = simulatedGateway();
else {
  const env = loadEnvOrExit(aiEnv, { label: 'eval:blocks' });
  if (!env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
    console.error('eval:blocks needs ANTHROPIC_API_KEY or OPENAI_API_KEY (or --simulated).');
    process.exit(2);
  }
  model = `${env.AI_MODEL_SMART} (judge ${env.AI_MODEL_AGENT})`;
  gateway = createAiGateway({
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
}
const judge = !values.simulated && !values['no-judge'];

const only = values.only ? new Set(values.only.split(',')) : undefined;
const businesses = loadBusinesses()
  .filter((business) => !only || only.has(business.id))
  .slice(0, values.limit ? Number(values.limit) : undefined);

const rows: RowReport[] = new Array(businesses.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.max(1, Math.min(Number(values.concurrency), businesses.length)) }, async () => {
    while (next < businesses.length) {
      const index = next++;
      const business = businesses[index];
      if (!business) continue;
      const workspace = evalWorkspace(business);
      const run = await runEngine(workspace, gateway, { budgetUsd: 1 });
      let judged: Record<string, number> | undefined;
      if (judge && run.spec) {
        const verdict = await gateway.run(
          GenerationSiteJudge,
          {
            business: {
              name: workspace.brief.identity.name,
              category: workspace.brief.identity.categoryLabel?.en ?? null,
              locality: workspace.brief.identity.locality,
            },
            locales: run.spec.locales,
            tone: workspace.brief.constraints.tone,
            facts: workspace.facts
              .filter((fact) => fact.usage === 'display')
              .map((fact) => ({
                id: fact.id,
                kind: fact.kind,
                value: (typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value)).slice(
                  0,
                  300,
                ),
              })),
            texts: siteTexts(run.spec),
          },
          { orgId: null },
        );
        judged = Object.fromEntries(SITE_JUDGE_CRITERIA.map((name) => [name, verdict.output[name]]));
      }
      rows[index] = rowReport(business, workspace, run, judged);
      console.log(
        `${business.id}: ${rows[index]?.outcome} in ${((rows[index]?.durationMs ?? 0) / 1000).toFixed(1)} s`,
      );
    }
  }),
);

const summary = summarize(rows);
const mode = values.simulated ? 'simulated' : 'live';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = new URL('reports/', new URL('.', DATASET));
mkdirSync(dir, { recursive: true });
const markdown = reportMarkdown(mode, model, rows, summary);
writeFileSync(new URL(`${mode}-${stamp}.md`, dir), markdown);
writeFileSync(
  new URL(`${mode}-${stamp}.json`, dir),
  `${JSON.stringify({ mode, model, startedAt: stamp, summary, failures: thresholdFailures(summary, { warnings: mode !== 'simulated' }), rows }, null, 2)}\n`,
);
console.log(markdown);
process.exit(thresholdFailures(summary, { warnings: mode !== 'simulated' }).length === 0 ? 0 : 1);
