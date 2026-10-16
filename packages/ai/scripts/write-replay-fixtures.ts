// node scripts/write-replay-fixtures.ts <task>
// Writes replay fixtures from `evals/<task>/replay-outputs.jsonl` (hand-written or simulated answers, one per dataset
// row, same order) for tasks whose answers were not recorded from a real model. Recorded fixtures (`pnpm eval
// --record`) replace them.
import { readFileSync } from 'node:fs';
import type { EvalConfig } from '../src/evals/define-eval.ts';
import type { EvalRow } from '../src/evals/scorers.ts';
import { loadPromptRegistry } from '../src/index.ts';
import { digestImage } from '../src/testing/fake-gateway.ts';
import { fixturePath, writeFixture } from '../src/testing/fixtures.ts';

const task = process.argv[2];
if (!task || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(task)) {
  console.error('Usage: node scripts/write-replay-fixtures.ts <context.name>');
  process.exit(2);
}
const root = new URL('..', import.meta.url);
const config = (await import(new URL(`evals/${task}/eval.config.ts`, root).href)).default as EvalConfig;
const lines = (file: string) =>
  readFileSync(new URL(`evals/${task}/${file}`, root), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { id: string; input?: unknown; output?: unknown });
const rows = lines('dataset.jsonl');
const outputs = lines('replay-outputs.jsonl');
if (rows.length !== outputs.length)
  throw new Error('replay-outputs.jsonl must have one line per dataset row');
const promptVersion = loadPromptRegistry().get(config.task.prompt).version;
for (const [index, row] of rows.entries()) {
  const answer = outputs[index];
  if (answer?.id !== row.id) throw new Error(`Row ${index}: expected ${row.id}, got ${answer?.id}`);
  // Vision rows hold `{ input, images }`: the fixture is keyed like the fake gateway keys it (image digests).
  const input =
    config.task.kind === 'vision'
      ? {
          input: config.task.input.parse((row.input as { input: unknown }).input),
          images: (config.images ? await config.images(row as EvalRow) : []).map(digestImage),
        }
      : config.task.input.parse(row.input);
  const output = 'output' in config.task ? config.task.output.parse(answer.output) : answer.output;
  writeFixture(fixturePath(new URL('fixtures/', root).pathname, task, promptVersion, input), {
    task,
    promptVersion,
    input,
    output,
  });
}
console.log(`${rows.length} fixtures written for ${task} v${promptVersion}`);
