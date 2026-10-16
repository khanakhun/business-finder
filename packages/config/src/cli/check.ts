// pnpm env:check [app...] — validates the current environment (.env, .env.generated, real env) for each app
// and prints every variable's status. Secret values are never printed. Exits 1 if any app is invalid.
import { EnvValidationError, loadEnv, readRawEnv } from '../load.ts';
import { APP_SCHEMAS, type AppName, isAppName } from '../registry.ts';
import { describeVariables } from '../schema.ts';

export function checkApps(
  apps: readonly AppName[],
  raw: Record<string, string | undefined>,
): { output: string; ok: boolean } {
  const out: string[] = [];
  let ok = true;
  for (const app of apps) {
    const schema = APP_SCHEMAS[app];
    out.push(`\n== ${app} ==`);
    for (const v of describeVariables(schema)) {
      const value = raw[v.name];
      let shown: string;
      if (value === undefined)
        shown = v.defaultValue === undefined ? '(unset)' : `(default) ${v.defaultValue}`;
      else shown = v.secret ? '(set, hidden)' : value;
      out.push(`  ${v.name.padEnd(30)} ${shown}`);
    }
    try {
      loadEnv(schema, { env: raw, files: [], label: app });
      out.push(`  ✔ ${app}: valid`);
    } catch (error) {
      if (!(error instanceof EnvValidationError)) throw error;
      ok = false;
      out.push('', error.report.replace(/^/gm, '  '));
    }
  }
  return { output: out.join('\n'), ok };
}

function main(args: readonly string[]): number {
  const unknown = args.filter((a) => !isAppName(a));
  if (unknown.length > 0) {
    console.error(
      `Unknown app(s): ${unknown.join(', ')}. Choose from: ${Object.keys(APP_SCHEMAS).join(', ')}`,
    );
    return 1;
  }
  const apps = args.length > 0 ? (args as AppName[]) : (Object.keys(APP_SCHEMAS) as AppName[]);
  const { output, ok } = checkApps(apps, readRawEnv());
  console.log(output);
  return ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
