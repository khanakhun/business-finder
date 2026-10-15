// pnpm eval --task <name> [--model <id>] [--limit <n>] [--replay | --record]
//   live (default): real models; keys from ANTHROPIC_API_KEY / OPENAI_API_KEY (costs money).
//   --replay: recorded answers in fixtures/ (CI, no network). --record: live, and saves the answers as fixtures.
// Writes evals/reports/<task>-<timestamp>.{md,json}; exits 1 below the thresholds in evals/<task>/eval.config.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ModelPricingSchema } from '../src/cost.ts';
import type { EvalConfig } from '../src/evals/define-eval.ts';
import { reportMarkdown, runEval } from '../src/evals/run-eval.ts';
import type { EvalRow } from '../src/evals/scorers.ts';
import { type AiGateway, createAiGateway, DEFAULT_EMBEDDING_MODEL, DEFAULT_TIERS } from '../src/index.ts';
import { createFakeAiGateway } from '../src/testing/fake-gateway.ts';

const ROOT = new URL('..', import.meta.url);
const FIXTURES = new URL('fixtures/', ROOT).pathname;

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      task: { type: 'string' },
      model: { type: 'string' },
      limit: { type: 'string' },
      replay: { type: 'boolean', default: false },
      record: { type: 'boolean', default: false },
    },
  });
  if (!values.task) {
    console.error('Usage: pnpm eval --task <name> [--model <id>] [--limit <n>] [--replay | --record]');
    return 2;
  }
  const config = (await import(new URL(`evals/${values.task}/eval.config.ts`, ROOT).href))
    .default as EvalConfig;
  const rows = readFileSync(new URL(`evals/${values.task}/dataset.jsonl`, ROOT), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as EvalRow)
    .slice(0, values.limit ? Number(values.limit) : undefined);

  const env = process.env;
  const live = (): AiGateway =>
    createAiGateway({
      routing: {
        tiers: {
          fast: env.AI_MODEL_FAST ?? DEFAULT_TIERS.fast,
          smart: env.AI_MODEL_SMART ?? DEFAULT_TIERS.smart,
          agent: env.AI_MODEL_AGENT ?? DEFAULT_TIERS.agent,
        },
        overrides: values.model ? { [config.task.name]: values.model } : {},
        embeddingModel: env.AI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
      },
      keys: {
        resolve: async (_org, provider) =>
          provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY,
      },
      pricing: env.AI_PRICING ? ModelPricingSchema.parse(JSON.parse(env.AI_PRICING)) : {},
    });
  const mode = values.replay ? 'replay' : values.record ? 'record' : 'live';
  if (mode !== 'replay' && !env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
    console.error('No ANTHROPIC_API_KEY or OPENAI_API_KEY: run with --replay to use the recorded fixtures.');
    return 2;
  }
  const gateway =
    mode === 'live'
      ? live()
      : createFakeAiGateway({
          fixturesDir: FIXTURES,
          mode,
          ...(mode === 'record' ? { gateway: live() } : {}),
        });
  const model =
    mode === 'replay'
      ? 'fixtures'
      : (values.model ??
        env[`AI_MODEL_${config.task.tier.toUpperCase()}`] ??
        DEFAULT_TIERS[config.task.tier]);
  const report = await runEval(config, rows, { gateway, model, mode });

  const reports = new URL('evals/reports/', ROOT);
  mkdirSync(reports, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  writeFileSync(new URL(`${values.task}-${stamp}.json`, reports), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(new URL(`${values.task}-${stamp}.md`, reports), reportMarkdown(report));
  console.log(reportMarkdown(report));
  if (!report.passed) console.error(`Below thresholds: ${report.failures.join('; ') || 'no rows'}`);
  return report.passed ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
