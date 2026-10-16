// Drizzle Kit wrapper: loads DATABASE_URL like the other db CLIs, and adds drift detection.
//   pnpm db:generate --name <snake_name>   new migration from schema changes (--custom for hand-written SQL)
//   pnpm db:studio                         Drizzle Studio against DATABASE_URL
//   pnpm db:check                          journal consistency + fails if the schema has unmigrated changes
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS_DIR } from '../migrate.ts';
import { loadCliEnv } from './env.ts';

const PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url));

function kit(args: readonly string[], extraEnv: Record<string, string> = {}, quiet = false) {
  return spawnSync('pnpm', ['exec', 'drizzle-kit', ...args], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, ...extraEnv },
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
}

// Drizzle Kit prefixes `./` to `out`, so the scratch copy must be a path relative to the package (git-ignored).
const DRIFT_DIR = '.drift-check';

/** Generates into a scratch copy of the migrations folder; any new SQL file means the schema drifted. */
function checkDrift(): number {
  const scratch = join(PACKAGE_DIR, DRIFT_DIR);
  rmSync(scratch, { recursive: true, force: true });
  try {
    cpSync(MIGRATIONS_DIR, scratch, { recursive: true });
    const before = new Set(readdirSync(scratch));
    const result = kit(['generate', '--name', 'drift_check'], { BF_DRIZZLE_OUT: DRIFT_DIR }, true);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const added = readdirSync(scratch).filter((f) => f.endsWith('.sql') && !before.has(f));
    // drizzle-kit exits 0 even when it crashes, so only a recognised outcome counts as success.
    const clean = /No schema changes/i.test(output);
    if (result.status !== 0 || (!clean && added.length === 0)) {
      console.error(`Drift check could not run drizzle-kit generate:\n${output}`);
      return 1;
    }
    if (added.length === 0) {
      console.log('No drift: schema matches the committed migrations.');
      return 0;
    }
    console.error(
      'Schema drift: src/schema has changes without a migration. Run `pnpm db:generate --name …`.',
    );
    for (const file of added)
      console.error(`\n--- would generate ${file} ---\n${readFileSync(join(scratch, file), 'utf8')}`);
    return 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'generate':
    process.exitCode = kit(['generate', ...rest]).status ?? 1;
    break;
  case 'studio':
    process.exitCode = kit(['studio', ...rest], { DATABASE_URL: loadCliEnv().DATABASE_URL }).status ?? 1;
    break;
  case 'check': {
    const consistency = kit(['check']).status ?? 1;
    process.exitCode = consistency !== 0 ? consistency : checkDrift();
    break;
  }
  default:
    console.error('Usage: kit.ts generate|studio|check [drizzle-kit args]');
    process.exitCode = 1;
}
