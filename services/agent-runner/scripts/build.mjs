// Bundles the supervisor (BF-043) into one Node 24 file for the runner image, with the fake agent the smoke test runs.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [join(root, 'src/main.ts')],
  outfile: join(dist, 'supervisor.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'none',
  banner: {
    js: "import { createRequire as __runnerRequire } from 'node:module';\nconst require = __runnerRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
cpSync(join(root, 'fake-agent/fake-agent.mjs'), join(dist, 'fake-agent.mjs'));
cpSync(join(root, 'home'), join(dist, 'home'), { recursive: true });
console.log(`agent-runner build: ${dist}`);
