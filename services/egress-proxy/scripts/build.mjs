// Bundles the egress proxy into one Node 24 file for its image (BF-043).
import { build } from 'esbuild';

await build({
  entryPoints: [new URL('../src/main.ts', import.meta.url).pathname],
  outfile: new URL('../dist/egress-proxy.mjs', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'none',
  logLevel: 'warning',
});
