import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISSUE_CODES, type SiteSpec } from '@bf/site-schema';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, limitsOf, loadConfig, SitekitConfigSchema } from './config.ts';
import { applyOps, diff, parseOperations, summarize } from './ops.ts';
import { assets, catalog, facts, readFacts, UnknownBlockError } from './readers.ts';
import { asSpec, readSiteRaw } from './site.ts';
import { pathString, validate } from './validate.ts';
import { Workspace, WorkspaceError } from './workspace.ts';

// sitekit's library core (BF-042): workspace confinement, config, validation with hints, operations, readers.

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/workspace-${name}/`, import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'sitekit-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function load(name: string) {
  const workspace = await Workspace.open(fixture(name));
  const config = await loadConfig(workspace);
  const { value, bytes } = await readSiteRaw(workspace, config);
  return { workspace, config, value, bytes, facts: await readFacts(workspace) };
}

describe('Workspace', () => {
  it('confines every path to the workspace, links included', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'sitekit-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'nope');
    symlinkSync(outside, join(scratch, 'escape'));
    writeFileSync(join(scratch, 'ok.txt'), 'yes');
    const workspace = await Workspace.open(scratch);
    expect(await workspace.readText('ok.txt')).toBe('yes');
    for (const path of ['../x', '/etc/passwd', 'escape/secret.txt', 'a/../../x', 'nul\0byte'])
      await expect(workspace.readText(path)).rejects.toMatchObject({ code: 'outside_workspace' });
    await expect(workspace.writeText('escape/new.txt', 'x')).rejects.toBeInstanceOf(WorkspaceError);
    await expect(workspace.readText('missing.txt')).rejects.toMatchObject({ code: 'not_found' });
    writeFileSync(join(scratch, 'big.txt'), 'x'.repeat(100));
    await expect(workspace.readText('big.txt', 10)).rejects.toMatchObject({ code: 'too_large' });
    writeFileSync(join(scratch, 'bad.json'), '{');
    await expect(workspace.readJson('bad.json')).rejects.toMatchObject({ code: 'invalid_json' });
    await workspace.writeText('out/dir/file.txt', 'written');
    expect(await workspace.readText('out/dir/file.txt')).toBe('written');
    await expect(Workspace.open(join(scratch, 'nope'))).rejects.toMatchObject({ code: 'not_found' });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('config', () => {
  it('defaults without a file, and only tightens limits', async () => {
    const empty = await Workspace.open(mkdtempSync(join(scratch, 'empty-')));
    const config = await loadConfig(empty);
    expect(config).toMatchObject({
      strictFacts: true,
      assetHosts: [],
      hotlinkHosts: ['images.unsplash.com'],
    });
    expect(limitsOf(config)).toEqual({ pages: 8, blocksPerPage: 20, specBytes: 1_000_000 });
    expect(SitekitConfigSchema.safeParse({ limits: { pages: 9 } }).success).toBe(false);
    expect(limitsOf(SitekitConfigSchema.parse({ limits: { pages: 3 } })).pages).toBe(3);
  });

  it('names the invalid field', async () => {
    const dir = mkdtempSync(join(scratch, 'cfg-'));
    writeFileSync(join(dir, '.sitekit.json'), JSON.stringify({ strictFacts: 'yes' }));
    await expect(loadConfig(await Workspace.open(dir))).rejects.toThrow(ConfigError);
    await expect(loadConfig(await Workspace.open(dir))).rejects.toThrow(/strictFacts/);
  });
});

describe('validate', () => {
  it('accepts the fixture workspaces', async () => {
    for (const name of ['salon', 'cafe']) {
      const { value, bytes, config, facts } = await load(name);
      expect(
        validate(value, { config, bytes, ...(facts ? { facts } : {}) }).filter((i) => i.severity === 'error'),
      ).toEqual([]);
    }
  });

  it('explains each problem with its path and a fix', async () => {
    const { value, config, facts } = await load('broken');
    const issues = validate(value, { config, ...(facts ? { facts } : {}) });
    const codes = issues.map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(['fact_mismatch', 'unsupported_literal']));
    const long = structuredClone(value) as {
      pages: { blocks: { props: { title: Record<string, string> } }[] }[];
    };
    const title = long.pages[0]?.blocks[0]?.props.title as Record<string, string>;
    for (const locale of Object.keys(title)) title[locale] = 'x'.repeat(74);
    const tooLong = validate(long, { config, strictFacts: false }).find(
      (issue) => issue.code === 'text_too_long',
    );
    expect(tooLong?.at).toMatch(/^pages\[0\]\.blocks\[0\]\.props\.title\.(fr|en)$/);
    expect(tooLong?.hint).toContain('currently 74 characters');
    expect(issues.find((issue) => issue.code === 'fact_mismatch')?.hint).toContain('sitekit facts');
  });

  it('has a hint for every issue code, and enforces strict facts and limits', async () => {
    const { value, config } = await load('salon');
    const strict = validate(value, { config });
    expect(strict.map((issue) => issue.code)).toContain('fact_unknown');
    expect(
      validate(value, { config, strictFacts: false }).some((issue) => issue.code === 'fact_unknown'),
    ).toBe(false);
    const tight = SitekitConfigSchema.parse({
      ...config,
      limits: { pages: 1, blocksPerPage: 2, specBytes: 2048 },
    });
    const limited = validate(value, { config: tight, strictFacts: false, bytes: 5000 });
    expect(limited.filter((issue) => issue.code === 'block_requirement').length).toBeGreaterThanOrEqual(2);
    expect(limited.some((issue) => issue.message.includes('bytes'))).toBe(true);
    expect(ISSUE_CODES.length).toBeGreaterThan(30);
    const schemaOnly = validate({ schemaVersion: 1 }, { config, strictFacts: false });
    expect(schemaOnly[0]).toMatchObject({ code: 'schema', hint: expect.stringContaining('JSON Schema') });
  });

  it('writes paths as agents read them', () => {
    expect(pathString(['pages', 0, 'blocks', 2, 'props', 'title', 'fr'])).toBe(
      'pages[0].blocks[2].props.title.fr',
    );
    expect(pathString([])).toBe('');
  });
});

describe('operations', () => {
  it('applies a batch atomically with its inverse, summary and diff', async () => {
    const { value } = await load('salon');
    const spec = asSpec(value) as SiteSpec;
    const block = spec.pages[0]?.blocks[0];
    const operation = parseOperations([
      {
        op: 'updateText',
        path: ['pages', 0, 'blocks', 0, 'props', 'title'],
        locale: 'fr',
        value: 'Salon Lumière',
      },
    ]);
    const applied = applyOps(spec, operation);
    expect(applied.summary).toBe('1 operation: updateText');
    const changes = diff(spec, applied.spec);
    expect(changes.summary).toMatch(/text/i);
    const undone = applyOps(applied.spec, applied.inverse);
    expect(undone.spec).toEqual(spec);
    expect(block).toBeDefined();
    expect(() => parseOperations({ op: 'nope' })).toThrow(/Unknown operation "nope".*updateText/);
    expect(() => parseOperations([{ op: 'updateText', path: [] }])).toThrow(/sitekit ops list/);
    expect(summarize({ op: 'batch', ops: [] })).toBe('0 operations');
  });
});

describe('readers', () => {
  it('reads the catalog, facts and assets', async () => {
    const all = catalog();
    expect(all.length).toBeGreaterThanOrEqual(16);
    const hero = catalog({ block: 'hero' });
    expect(hero).toHaveLength(1);
    expect(hero[0]?.markdown).toContain('hero');
    expect(JSON.stringify(hero[0]?.schema)).toContain('"HeroBlock"');
    expect(() => catalog({ block: 'carousel' })).toThrow(UnknownBlockError);
    const workspace = await Workspace.open(fixture('salon'));
    expect((await facts(workspace, { kind: 'phone' })).every((fact) => fact.kind === 'phone')).toBe(true);
    expect((await facts(workspace, { search: 'gustavia' })).length).toBeGreaterThan(0);
    expect((await assets(workspace, { role: 'logo' })).every((asset) => asset.kind === 'logo')).toBe(true);
    const empty = await Workspace.open(mkdtempSync(join(scratch, 'none-')));
    expect(await facts(empty)).toEqual([]);
    expect(await assets(empty)).toEqual([]);
  });
});
