// pnpm db:seed [--only <module>[,<module>]] [--env dev|test|staging]
// The `team` module runs when SEED_WORKSPACE_MEMBERS is set (see seed/modules/team.ts).
import { closeDb, createDb } from '../client.ts';
import { SEED_MODULES } from '../seed/modules/index.ts';
import { parseTeamMembers, TeamSeedConfigError, teamSeedModule } from '../seed/modules/team.ts';
import { runSeeds, type SeedEnvironment, type SeedModule } from '../seed/runner.ts';
import { flagValues, loadCliEnv } from './env.ts';

const ENVIRONMENTS: Record<string, SeedEnvironment> = {
  development: 'dev',
  test: 'test',
  production: 'staging',
};
const args = process.argv.slice(2);
const env = loadCliEnv();
const requested = flagValues(args, '--env')[0];
if (requested !== undefined && !['dev', 'test', 'staging'].includes(requested)) {
  console.error(`--env must be dev, test or staging, got "${requested}"`);
  process.exit(1);
}
const environment = (requested as SeedEnvironment | undefined) ?? ENVIRONMENTS[env.NODE_ENV] ?? 'dev';
const only = flagValues(args, '--only')
  .flatMap((v) => v.split(','))
  .filter(Boolean);

let modules: readonly SeedModule[] = SEED_MODULES;
if (env.SEED_WORKSPACE_MEMBERS) {
  try {
    const members = parseTeamMembers(env.SEED_WORKSPACE_MEMBERS);
    modules = [...SEED_MODULES, teamSeedModule({ workspace: env.SEED_WORKSPACE_NAME, members })];
  } catch (error) {
    if (!(error instanceof TeamSeedConfigError)) throw error;
    console.error(`SEED_WORKSPACE_MEMBERS: ${error.message}`);
    process.exit(1);
  }
}

const db = createDb({ url: env.DATABASE_URL, max: 1, applicationName: 'bf-seed' });
try {
  const ran = await runSeeds(db, modules, {
    environment,
    ...(only.length > 0 ? { only } : {}),
    log: console.log,
  });
  console.log(`Seeded (${environment}): ${ran.length > 0 ? ran.join(', ') : 'nothing to seed'}`);
} finally {
  await closeDb(db);
}
