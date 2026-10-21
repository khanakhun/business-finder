import { coreEnv, dbEnv, loadEnvOrExit } from '@bf/config';
import { z } from 'zod';

const cliEnv = z.object({
  NODE_ENV: coreEnv.shape.NODE_ENV,
  DATABASE_URL: dbEnv.shape.DATABASE_URL,
  SEED_WORKSPACE_NAME: z
    .string()
    .trim()
    .min(1)
    .default('Hunzokutz')
    .describe('Workspace created by the team seed.'),
  SEED_WORKSPACE_MEMBERS: z
    .string()
    .optional()
    .describe('Team seed people: `email:role,email:role` (owner|admin|member|viewer). Unset: no team seed.'),
});

/** DATABASE_URL (from .env / .env.generated / real env) for the db CLIs; exits with a report if missing. */
export function loadCliEnv() {
  return loadEnvOrExit(cliEnv, { label: 'db' });
}

/** Values of `--flag value` / `--flag=value`. */
export function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((arg, i) => {
    if (arg === flag && args[i + 1]) values.push(args[i + 1] as string);
    else if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
  });
  return values;
}
