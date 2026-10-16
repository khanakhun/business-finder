import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { collect, toMarkdown } from '../ci/coverage-summary.mjs';

const root = mkdtempSync(join(tmpdir(), 'bf-coverage-'));
after(() => rmSync(root, { recursive: true, force: true }));

function write(path, data) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify(data));
}

describe('coverage-summary', () => {
  it('reads Istanbul and coverage.py reports into one sorted table', () => {
    write('packages/db/coverage/coverage-summary.json', {
      total: { lines: { pct: 91.25 }, branches: { pct: 80 } },
    });
    write('services/intel/coverage/coverage.json', {
      totals: { percent_covered: 96.9, num_branches: 200, covered_branches: 190 },
    });
    write('apps/api/coverage/coverage-summary.json', { total: { lines: { pct: 88 }, branches: {} } });
    const rows = collect(root);
    assert.deepEqual(
      rows.map((r) => r.workspace),
      ['apps/api', 'packages/db', 'services/intel'],
    );
    const markdown = toMarkdown(rows);
    assert.match(markdown, /\| `packages\/db` \| 91\.3 % \| 80\.0 % \|/);
    assert.match(markdown, /\| `services\/intel` \| 96\.9 % \| 95\.0 % \|/);
    assert.match(markdown, /\| `apps\/api` \| 88\.0 % \| — \|/);
  });

  it('says so when nothing ran', () => {
    assert.match(toMarkdown([]), /No coverage reports/);
  });
});
