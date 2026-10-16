import type { DbClient } from '../client.ts';
import { type DbExecutor, runInTransaction } from '../tx.ts';

export type SeedEnvironment = 'dev' | 'test' | 'staging';

export interface SeedModule {
  /** Unique, kebab-case; used by `pnpm db:seed --only <name>`. */
  readonly name: string;
  readonly environments: readonly SeedEnvironment[];
  /**
   * Must be idempotent (upserts / ON CONFLICT DO NOTHING): seeds are re-run freely. Receives the module's
   * transaction; use it (or `getExecutor`) for every query so a failure rolls the whole module back.
   */
  run(tx: DbExecutor): Promise<void>;
}

export interface RunSeedsOptions {
  readonly environment: SeedEnvironment;
  /** Run only these modules (still filtered by environment). */
  readonly only?: readonly string[];
  readonly log?: (line: string) => void;
}

/** Runs seed modules in array order, each in its own transaction. Returns the names that ran. */
export async function runSeeds(
  db: DbClient,
  modules: readonly SeedModule[],
  options: RunSeedsOptions,
): Promise<string[]> {
  const names = new Set(modules.map((m) => m.name));
  if (names.size !== modules.length) throw new Error('Seed module names must be unique');
  const unknown = (options.only ?? []).filter((name) => !names.has(name));
  if (unknown.length > 0) throw new Error(`Unknown seed module(s): ${unknown.join(', ')}`);

  const selected = modules.filter(
    (m) => m.environments.includes(options.environment) && (!options.only || options.only.includes(m.name)),
  );
  const log = options.log ?? (() => undefined);
  for (const module of selected) {
    log(`seed ${module.name} …`);
    await runInTransaction(db, (tx) => module.run(tx));
  }
  return selected.map((m) => m.name);
}
