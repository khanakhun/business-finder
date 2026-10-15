// pnpm search:reindex [--model <provider:model>] [--batch <n>]
// Backfills business embeddings (BF-022): embeds every live business whose text or embedding model differs from
// the stored vector. Resumable — re-running skips what is already current. `--model` embeds with another model
// than AI_EMBEDDING_MODEL (switch the config to it afterwards: semantic ranking only compares same-model vectors).
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.ts';
import { loadAppEnv } from '../modules/platform/config/app-env.ts';
import { BusinessEmbedder } from '../modules/search/index.ts';

const { values } = parseArgs({ options: { model: { type: 'string' }, batch: { type: 'string' } } });
const batchSize = Number(values.batch ?? 96);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2_000) {
  console.error('--batch must be an integer between 1 and 2000');
  process.exit(1);
}
const env = loadAppEnv('http');
if (values.model) env.AI_EMBEDDING_MODEL = values.model;
// HTTP mode without listening: the full container (AI gateway, budgets, llm_calls) but no queue workers.
const app = await NestFactory.createApplicationContext(AppModule.forHttp(env), { logger: ['error', 'warn'] });
try {
  const report = await app.get(BusinessEmbedder).reindex({
    batchSize,
    onBatch: (r) => console.log(`search:reindex … ${r.embedded} embedded, ${r.upToDate} up to date`),
  });
  console.log(
    `search:reindex ${env.AI_EMBEDDING_MODEL}: ${report.embedded} embedded, ${report.upToDate} up to date` +
      (report.skipped ? ` (stopped: ${report.skipped})` : ''),
  );
  if (report.skipped) process.exitCode = 2;
} finally {
  await app.close();
}
