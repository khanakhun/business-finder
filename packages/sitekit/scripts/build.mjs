// Bundles the sitekit CLI into one Node 24 file (dist/sitekit.mjs) for the agent runner image (BF-042 → BF-043),
// with the copy lint rules and the block library's stylesheet and fonts next to it. Playwright, Lighthouse and axe stay
// external: the runner image installs them, with Playwright's Chromium.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src/cli/bin.ts')],
  outfile: join(dist, 'sitekit.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  jsx: 'automatic',
  legalComments: 'none',
  external: ['playwright', 'playwright-core', 'lighthouse', '@axe-core/playwright', 'axe-core'],
  // CommonJS dependencies inside an ES module bundle need `require`.
  banner: {
    js: "import { createRequire as __sitekitRequire } from 'node:module';\nconst require = __sitekitRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

cpSync(join(root, 'rules'), join(dist, 'rules'), { recursive: true });
// The package exports its renderer (src/static/…), not package.json: its root is three levels up.
const blocks = join(
  dirname(dirname(dirname(createRequire(import.meta.url).resolve('@bf/site-blocks/static')))),
  'dist',
);
if (existsSync(join(blocks, 'styles.css'))) {
  mkdirSync(join(dist, 'site-blocks'), { recursive: true });
  cpSync(join(blocks, 'styles.css'), join(dist, 'site-blocks', 'styles.css'));
  cpSync(join(blocks, 'fonts'), join(dist, 'site-blocks', 'fonts'), { recursive: true });
} else {
  console.warn(
    'sitekit build: @bf/site-blocks is not built (pnpm --filter @bf/site-blocks build): no stylesheet bundled.',
  );
}
console.log(`sitekit build: ${join(dist, 'sitekit.mjs')}`);
