import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SiteSpec } from '@bf/site-schema';
import { afterAll, describe, expect, it } from 'vitest';
import { check } from './check.ts';
import { loadConfig } from './config.ts';
import { renderSite } from './render.ts';
import { screenshot, serveFolder } from './screenshot.ts';
import { asSpec, readSiteRaw } from './site.ts';
import { Workspace } from './workspace.ts';

// Real Chromium (BF-042): run with SITEKIT_BROWSER=1 where Playwright's Chromium is installed (the CI sites job).
// Deterministic pixels, nothing but loopback requests, and `check` within its time budget.

const browser = process.env.SITEKIT_BROWSER === '1';
const scratch = mkdtempSync(join(tmpdir(), 'sitekit-browser-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function salon() {
  const dir = join(scratch, `salon-${Math.random().toString(36).slice(2)}`);
  cpSync(fileURLToPath(new URL('../../fixtures/workspace-salon/', import.meta.url)), dir, {
    recursive: true,
  });
  const workspace = await Workspace.open(dir);
  const config = await loadConfig(workspace);
  return { workspace, dir, spec: asSpec((await readSiteRaw(workspace, config)).value) as SiteSpec };
}

describe.runIf(browser)('screenshots in Chromium', () => {
  it('photographs the home page deterministically, without leaving the machine', async () => {
    const { workspace, spec, dir } = await salon();
    await renderSite(workspace, spec);
    const requests = [
      { page: 'home', locale: 'fr' as const, viewport: 'mobile' as const },
      { page: 'home', locale: 'fr' as const, viewport: 'desktop' as const },
    ];
    const first = await screenshot(workspace, spec, '.sitekit/render', requests, 'shots/a');
    const second = await screenshot(workspace, spec, '.sitekit/render', requests, 'shots/b');
    expect(first.map((shot) => [shot.viewport, shot.width, shot.height])).toEqual([
      ['mobile', 390, 844],
      ['desktop', 1440, 900],
    ]);
    for (const [index, shot] of first.entries())
      expect(
        readFileSync(join(dir, shot.file)).equals(readFileSync(join(dir, second[index]?.file as string))),
      ).toBe(true);
  }, 60_000);

  it('finishes check within its budget', async () => {
    const { workspace } = await salon();
    const report = await check(workspace);
    expect(report.blocking).toEqual([]);
    expect(report.counts.screenshots).toBe(2);
    expect(report.durationMs).toBeLessThan(15_000);
  }, 60_000);
});

describe.runIf(browser && existsSync(fileURLToPath(new URL('../../dist/sitekit.mjs', import.meta.url))))(
  'the bundled CLI',
  () => {
    it('validates cold in under 400 ms and checks a fixture to done', async () => {
      const { spawnSync } = await import('node:child_process');
      const cli = fileURLToPath(new URL('../../dist/sitekit.mjs', import.meta.url));
      const cwd = fileURLToPath(new URL('../../fixtures/workspace-salon/', import.meta.url));
      const started = performance.now();
      const validate = spawnSync(process.execPath, [cli, 'validate', '--cwd', cwd]);
      const elapsed = performance.now() - started;
      expect(validate.status).toBe(0);
      expect(elapsed).toBeLessThan(400);
      const { workspace } = await salon();
      const done = spawnSync(process.execPath, [cli, 'check', '--json', '--cwd', workspace.root]);
      expect(done.status, done.stderr.toString()).toBe(0);
      expect(JSON.parse(done.stdout.toString())).toMatchObject({
        command: 'check',
        ok: true,
        data: { done: true },
      });
    }, 60_000);
  },
);

describe('the loopback server', () => {
  it('serves its folder only', async () => {
    const dir = mkdtempSync(join(scratch, 'serve-'));
    const server = await serveFolder(dir);
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect((await fetch(`${server.origin}/../../etc/passwd`)).status).toBe(404);
      expect((await fetch(`${server.origin}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
      expect(existsSync(dir)).toBe(true);
    } finally {
      await server.close();
    }
  });
});
