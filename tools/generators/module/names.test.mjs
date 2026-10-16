import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { generateModule } from './generate.mjs';
import { names } from './names.mjs';

describe('names', () => {
  it('derives every form from kebab-case', () => {
    assert.deepEqual(names('lead-capture'), {
      kebab: 'lead-capture',
      pascal: 'LeadCapture',
      camel: 'leadCapture',
      constant: 'LEAD_CAPTURE',
      route: 'lead-capture',
    });
  });

  it('rejects bad and reserved names', () => {
    for (const bad of ['LeadCapture', 'lead_capture', '-x', '1x', 'platform', 'system'])
      assert.throws(() => names(bad));
  });
});

describe('generateModule', () => {
  const fakeRepo = () => {
    const root = mkdtempSync(join(tmpdir(), 'bf-gen-'));
    mkdirSync(join(root, 'packages/contracts/src'), { recursive: true });
    mkdirSync(join(root, 'apps/api/src'), { recursive: true });
    writeFileSync(join(root, 'packages/contracts/src/index.ts'), "export * from './ids.ts';\n");
    writeFileSync(
      join(root, 'apps/api/src/app.module.ts'),
      "import { SystemModule } from './modules/system/system.module.ts';\nconst imports = [\n        SystemModule.forRoot(mode),\n];\n",
    );
    return root;
  };

  it('writes the layered layout and wires the module', () => {
    const root = fakeRepo();
    const touched = generateModule(root, 'lead-capture');
    for (const layer of ['domain', 'application', 'infrastructure', 'interface']) {
      assert.ok(
        touched.some((p) => p.includes(`/modules/lead-capture/${layer}/`)),
        layer,
      );
    }
    assert.ok(touched.some((p) => p.endsWith('.test.ts')));
    assert.match(
      readFileSync(join(root, 'packages/contracts/src/index.ts'), 'utf8'),
      /export \* from '\.\/lead-capture\.ts';/,
    );
    const app = readFileSync(join(root, 'apps/api/src/app.module.ts'), 'utf8');
    assert.match(app, /import \{ LeadCaptureModule \} from '\.\/modules\/lead-capture\/index\.ts';/);
    assert.match(app, /LeadCaptureModule\.forRoot\(mode\),/);
  });

  it('refuses to overwrite an existing module', () => {
    const root = fakeRepo();
    generateModule(root, 'lead-capture');
    assert.throws(() => generateModule(root, 'lead-capture'), /Refusing to overwrite/);
  });
});
