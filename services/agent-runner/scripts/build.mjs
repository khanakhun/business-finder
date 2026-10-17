// Bundles the supervisor (BF-043) and the Agent SDK runner (BF-044) into Node 24 files for the runner image, with the
// fake agents the tests run.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'none',
  banner: {
    js: "import { createRequire as __runnerRequire } from 'node:module';\nconst require = __runnerRequire(import.meta.url);",
  },
  logLevel: 'warning',
};
await build({ ...common, entryPoints: [join(root, 'src/main.ts')], outfile: join(dist, 'supervisor.mjs') });
// The Agent SDK side of the claude-agent-sdk engine (BF-044): the SDK bundled, the image's Claude Code as its CLI.
await build({
  ...common,
  entryPoints: [join(root, 'src/agent-sdk-runner.ts')],
  outfile: join(dist, 'agent-sdk-runner.mjs'),
});
cpSync(join(root, 'fake-agent/fake-agent.mjs'), join(dist, 'fake-agent.mjs'));
cpSync(join(root, 'fake-agent/fake-claude.mjs'), join(dist, 'fake-claude.mjs'));
cpSync(join(root, 'fake-agent/fake-codex.mjs'), join(dist, 'fake-codex.mjs'));
cpSync(join(root, 'home'), join(dist, 'home'), { recursive: true });
console.log(`agent-runner build: ${dist}`);
