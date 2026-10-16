// pnpm --filter @bf/site-blocks build — the shared stylesheet (BF-034): self-hosted fonts (latin + latin-ext
// subsets copied from their Fontsource packages, with their licenses) and their @font-face rules, then Tailwind's
// compiled utilities and components. Writes dist/styles.css and dist/fonts/.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_FAMILIES, type FontFamilyFiles } from '../fonts/families.ts';
import { fontFaces } from '../fonts/font-face.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = join(root, 'dist');
const fonts = join(dist, 'fonts');
const require = createRequire(import.meta.url);

/** The package stylesheets that declare a family's faces (upright and italic). */
function stylesheets(files: FontFamilyFiles): string[] {
  if (files.axes.variable) return ['wght.css', 'wght-italic.css'];
  return files.axes.weights.flatMap((weight) => [`${weight}.css`, `${weight}-italic.css`]);
}

function build() {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(fonts, 'licenses'), { recursive: true });
  const rules: string[] = [];
  for (const files of FONT_FAMILIES) {
    const pkgDir = dirname(require.resolve(`${files.pkg}/package.json`));
    for (const sheet of stylesheets(files)) {
      let css: string;
      try {
        css = readFileSync(join(pkgDir, sheet), 'utf8');
      } catch {
        continue; // a family without italics
      }
      const faces = fontFaces(css, files);
      rules.push(...faces.rules);
      for (const url of faces.urls) copyFileSync(join(pkgDir, 'files', url), join(fonts, url));
    }
    copyFileSync(join(pkgDir, 'LICENSE'), join(fonts, 'licenses', `${files.slug}.txt`));
  }
  const tailwind = join(dist, 'tailwind.css');
  // Tailwind's CLI (a direct dev dependency, linked in this package's node_modules).
  const cli = join(root, 'node_modules/@tailwindcss/cli/dist/index.mjs');
  execFileSync(process.execPath, [cli, '-i', join(root, 'src/styles/base.css'), '-o', tailwind, '--minify'], {
    stdio: ['ignore', 'ignore', 'inherit'],
    cwd: root,
  });
  writeFileSync(join(dist, 'styles.css'), `${rules.join('\n')}\n${readFileSync(tailwind, 'utf8')}`);
  rmSync(tailwind);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) build();
