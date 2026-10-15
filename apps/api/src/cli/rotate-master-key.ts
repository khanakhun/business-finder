// pnpm secrets:rotate-master
// Re-wraps every workspace secret's data key with the current master key (SECRETS_MASTER_KEY, version
// SECRETS_MASTER_KEY_VERSION), reading old rows with SECRETS_MASTER_KEY_PREVIOUS. Secret values are never decrypted.
// Idempotent and resumable: rows already on the current version are skipped; each batch commits on its own.
// Runbook: docs/runbooks/secrets-rotation.md.
import 'reflect-metadata';
import { closeDb, createDb, type DbClient, runInTransaction } from '@bf/db';
import { sql } from 'drizzle-orm';
import { loadAppEnv } from '../modules/platform/config/app-env.ts';
import { rewrapSecret } from '../modules/platform/crypto/envelope.ts';
import type { MasterKeyProvider } from '../modules/workspace/application/ports.ts';
import { DrizzleAuditLogRepository } from '../modules/workspace/infrastructure/drizzle-audit-log.repository.ts';
import { DrizzleSecretsRepository } from '../modules/workspace/infrastructure/drizzle-secrets.repository.ts';
import { EnvMasterKeyProvider } from '../modules/workspace/infrastructure/env-master-key.provider.ts';

export interface RotationReport {
  readonly toVersion: number;
  readonly rotated: number;
  /** Rows wrapped by a version this process has no key for (set SECRETS_MASTER_KEY_PREVIOUS and re-run). */
  readonly skipped: number;
  readonly skippedVersions: readonly number[];
}

const BATCH_SIZE = 100;

export async function rotateMasterKey(
  db: DbClient,
  keys: MasterKeyProvider,
  options: { readonly now?: () => Date; readonly batchSize?: number } = {},
): Promise<RotationReport> {
  const secrets = new DrizzleSecretsRepository(db);
  const current = keys.current();
  const batchSize = options.batchSize ?? BATCH_SIZE;
  let rotated = 0;
  const skippedVersions = new Map<number, number>();
  let afterId: string | undefined;

  for (;;) {
    const batch = await runInTransaction(db, async (tx) => {
      // Concurrent runs take turns per batch; the compare-and-set in `rewrap` makes a lost race harmless.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('bf:secrets:rotate-master'))`);
      const rows = await secrets.listForRotation(current.version, batchSize, afterId);
      let batchRotated = 0;
      let batchSkipped = 0;
      for (const row of rows) {
        const from = keys.get(row.keyVersion);
        if (!from) {
          skippedVersions.set(row.keyVersion, (skippedVersions.get(row.keyVersion) ?? 0) + 1);
          batchSkipped++;
          continue;
        }
        const rewrapped = rewrapSecret(row, { key: from, version: row.keyVersion }, current, {
          orgId: row.organizationId,
          name: row.name,
        });
        const updated = await secrets.rewrap(
          row.id,
          { keyVersion: row.keyVersion, dekIv: row.dekIv },
          {
            keyVersion: current.version,
            wrappedDek: rewrapped.wrappedDek,
            dekIv: rewrapped.dekIv,
            dekTag: rewrapped.dekTag,
          },
        );
        if (updated) batchRotated++;
      }
      // Audited in the same transaction as the batch, so committed work is never missing from the log.
      if (batchRotated > 0 || batchSkipped > 0) {
        await new DrizzleAuditLogRepository(db).insert({
          organizationId: null,
          actorType: 'system',
          actorId: 'cli:secrets:rotate-master',
          action: 'secrets.master_key_rotated',
          entityType: null,
          entityId: null,
          ip: null,
          userAgent: null,
          metadata: { toVersion: current.version, rotated: batchRotated, skipped: batchSkipped },
          occurredAt: options.now?.() ?? new Date(),
        });
      }
      rotated += batchRotated;
      return rows;
    });
    if (batch.length < batchSize) break;
    afterId = batch.at(-1)?.id;
  }

  const report: RotationReport = {
    toVersion: current.version,
    rotated,
    skipped: [...skippedVersions.values()].reduce((sum, n) => sum + n, 0),
    skippedVersions: [...skippedVersions.keys()].sort(),
  };
  return report;
}

async function main(): Promise<number> {
  const env = loadAppEnv('worker');
  const db = createDb({ url: env.DATABASE_URL, max: 2, applicationName: 'bf-rotate-master-key' });
  try {
    const report = await rotateMasterKey(db, new EnvMasterKeyProvider(env));
    console.log(`Re-wrapped ${report.rotated} secret(s) to master key version ${report.toVersion}.`);
    if (report.skipped > 0) {
      console.error(
        `${report.skipped} secret(s) use key version(s) ${report.skippedVersions.join(', ')} with no key configured: ` +
          'set SECRETS_MASTER_KEY_PREVIOUS to that key and re-run.',
      );
      return 1;
    }
    return 0;
  } finally {
    await closeDb(db);
  }
}

if (import.meta.main) process.exitCode = await main();
