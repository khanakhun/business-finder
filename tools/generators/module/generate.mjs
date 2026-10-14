import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { names } from './names.mjs';
import { templates, wiring } from './templates.mjs';

const CONTRACTS_INDEX = 'packages/contracts/src/index.ts';
const APP_MODULE = 'apps/api/src/app.module.ts';
const ENTRY_ANCHOR = '        SystemModule.forRoot(mode),';
const IMPORT_ANCHOR = "import { SystemModule } from './modules/system/system.module.ts';";

/** Writes the module files and wires it into the contracts index and AppModule. Returns the paths touched. */
export function generateModule(root, context) {
  const n = names(context);
  const files = templates(n);
  const conflicts = Object.keys(files).filter((path) => existsSync(join(root, path)));
  if (conflicts.length > 0) throw new Error(`Refusing to overwrite: ${conflicts.join(', ')}`);

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  const w = wiring(n);
  const contractsPath = join(root, CONTRACTS_INDEX);
  writeFileSync(contractsPath, `${readFileSync(contractsPath, 'utf8').trimEnd()}\n${w.contractsExport}\n`);

  const appPath = join(root, APP_MODULE);
  const app = readFileSync(appPath, 'utf8');
  if (!app.includes(IMPORT_ANCHOR) || !app.includes(ENTRY_ANCHOR)) {
    throw new Error(`${APP_MODULE} changed shape; wire ${n.pascal}Module by hand: ${w.appModuleEntry}`);
  }
  writeFileSync(
    appPath,
    app
      .replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}\n${w.appModuleImport}`)
      .replace(ENTRY_ANCHOR, `${ENTRY_ANCHOR}\n        ${w.appModuleEntry}`),
  );
  return [...Object.keys(files), CONTRACTS_INDEX, APP_MODULE];
}
