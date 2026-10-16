import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkBoundaries, format } from '../check-boundaries.mjs';

/** Writes a fixture monorepo: `{ 'apps/web/src/a.ts': 'import …' }` plus a package.json per workspace. */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'bf-boundaries-'));
  const workspaces = { 'apps/web': '@bf/web', 'apps/api': '@bf/api', 'packages/ui': '@bf/ui' };
  Object.assign(workspaces, { 'packages/contracts': '@bf/contracts', 'packages/db': '@bf/db' });
  for (const [dir, name] of Object.entries(workspaces))
    write(root, `${dir}/package.json`, JSON.stringify({ name }));
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  roots.push(root);
  return root;
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const rulesHit = (root) => checkBoundaries(root).violations.map((v) => `${v.file}:${v.line} ${v.rule}`);

describe('check-boundaries', () => {
  it('accepts the allowed dependency directions', () => {
    const root = fixture({
      'apps/web/src/page.tsx': "import { Button } from '@bf/ui';\nimport { newId } from '@bf/contracts';\n",
      'apps/api/src/modules/sites/domain/site.ts':
        "import { z } from 'zod';\nimport { SiteId } from '@bf/contracts';\n",
      'apps/api/src/modules/sites/infrastructure/repo.ts':
        "import { db } from '@bf/db';\nimport '../domain/site.ts';\n",
      'apps/api/src/modules/sites/domain/rules.ts': "import { site } from './site.ts';\n",
      'packages/ui/src/button.tsx': "import { cn } from './utils.ts';\n",
      'packages/contracts/src/ids.ts': "import { v7 } from 'uuid';\nimport { x } from './encoding.ts';\n",
      'packages/contracts/vitest.config.ts': "import { config } from '@bf/testing/vitest-config';\n",
    });
    assert.deepEqual(rulesHit(root), []);
  });

  it('rejects app → app imports by package name and by relative path', () => {
    const root = fixture({
      'apps/web/src/a.ts': "import { x } from '@bf/api/src/x';\n",
      'apps/web/src/b.ts': "\n\nexport { y } from '../../api/src/y.ts';\n",
      'apps/web/src/c.ts': "const z = await import('@bf/api');\n",
    });
    assert.deepEqual(rulesHit(root), [
      'apps/web/src/a.ts:1 app-to-app',
      'apps/web/src/b.ts:3 app-to-app',
      'apps/web/src/c.ts:1 app-to-app',
    ]);
  });

  it('rejects package → app and contracts → other packages', () => {
    const root = fixture({
      'packages/ui/src/x.ts': "import type { Page } from '@bf/web';\n",
      'packages/contracts/src/a.ts': "import { db } from '@bf/db';\n",
      'packages/contracts/src/b.ts': "const ui = require('../../ui/src/index.ts');\n",
    });
    assert.deepEqual(rulesHit(root), [
      'packages/contracts/src/a.ts:1 contracts-leaf',
      'packages/contracts/src/b.ts:1 contracts-leaf',
      'packages/ui/src/x.ts:1 package-to-app',
    ]);
  });

  it('keeps domain code free of frameworks, databases, HTTP and outer layers', () => {
    const root = fixture({
      'apps/api/src/modules/sites/domain/a.ts': "import { Injectable } from '@nestjs/common';\n",
      'apps/api/src/modules/sites/domain/b.ts':
        "import { eq } from 'drizzle-orm/sql';\nimport http from 'node:http';\n",
      'apps/api/src/modules/sites/domain/c.ts': "import { Repo } from '../infrastructure/repo.ts';\n",
      'apps/api/src/modules/sites/domain/sub/d.ts':
        "import { UseCase } from '../../application/use-case.ts';\n",
      'apps/api/src/modules/sites/domain/e.ts': "import { db } from '@bf/db';\n",
    });
    assert.deepEqual(rulesHit(root), [
      'apps/api/src/modules/sites/domain/a.ts:1 pure-domain',
      'apps/api/src/modules/sites/domain/b.ts:1 pure-domain',
      'apps/api/src/modules/sites/domain/b.ts:2 pure-domain',
      'apps/api/src/modules/sites/domain/c.ts:1 pure-domain',
      'apps/api/src/modules/sites/domain/e.ts:1 pure-domain',
      'apps/api/src/modules/sites/domain/sub/d.ts:1 pure-domain',
    ]);
  });

  it('keeps server-only packages out of the dashboard', () => {
    const root = fixture({ 'apps/web/src/x.ts': "import { db } from '@bf/db/client';\n" });
    assert.deepEqual(rulesHit(root), ['apps/web/src/x.ts:1 web-no-server-packages']);
  });

  it('ignores comments, strings and build output', () => {
    const root = fixture({
      'apps/web/src/ok.ts': "// import { x } from '@bf/api';\nconst s = \"import '@bf/api'\";\n",
      'apps/web/.next/server/chunk.js': "require('@bf/api');\n",
      'apps/web/node_modules/dep/index.js': "require('@bf/api');\n",
    });
    assert.deepEqual(rulesHit(root), []);
  });

  it('formats violations as file:line with the rule and the import', () => {
    const root = fixture({ 'packages/ui/src/x.ts': "import '@bf/web';\n" });
    const [violation] = checkBoundaries(root).violations;
    assert.match(format(violation), /^packages\/ui\/src\/x\.ts:1 {2}\[package-to-app\] import '@bf\/web' — /);
  });
});
