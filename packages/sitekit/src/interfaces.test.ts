import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createSitekitAgentTools } from './agent-tools.ts';
import { HELP, parseArgs, run } from './cli/main.ts';
import { EXIT, OUTPUT_SCHEMAS, outputSchemaFiles } from './cli/output.ts';
import { Workspace } from './lib/workspace.ts';
import { createSitekitMcpServer } from './mcp.ts';
import { runTool, SITEKIT_TOOLS } from './tools.ts';

// The interfaces (BF-042): CLI (commands, exit codes, JSON envelopes), MCP server and Agent SDK tools — the same
// tools giving the same results.

const scratch = mkdtempSync(join(tmpdir(), 'sitekit-interfaces-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function copy(name: string): string {
  const dir = join(scratch, `${name}-${Math.random().toString(36).slice(2)}`);
  cpSync(fileURLToPath(new URL(`../fixtures/workspace-${name}/`, import.meta.url)), dir, { recursive: true });
  return dir;
}

describe('CLI', () => {
  it('validates with exit codes 0 and 1 and a stable JSON envelope', async () => {
    const ok = await run(['validate', '--cwd', copy('salon')]);
    expect(ok).toMatchObject({ exitCode: EXIT.ok });
    expect(OUTPUT_SCHEMAS.validate.parse(ok.data).errors).toBe(0);
    const broken = await run(['validate', '--cwd', copy('broken'), '--json']);
    expect(broken.exitCode).toBe(EXIT.issues);
    const data = OUTPUT_SCHEMAS.validate.parse(broken.data);
    expect(data.errors).toBeGreaterThan(0);
    expect(broken.human).toMatch(/fix: /);
    expect(OUTPUT_SCHEMAS.envelope.parse({ command: 'validate', ok: false, exitCode: 1, data }).ok).toBe(
      false,
    );
  });

  it('lints and fixes copy', async () => {
    const dir = copy('salon');
    const before = await run(['lint-copy', '--cwd', dir, '--locale', 'fr']);
    expect(OUTPUT_SCHEMAS['lint-copy'].parse(before.data).issues.length).toBeGreaterThan(0);
    const fixed = await run(['lint-copy', '--cwd', dir, '--fix']);
    expect(OUTPUT_SCHEMAS['lint-copy'].parse(fixed.data).fixed).toBeGreaterThan(0);
    expect(readFileSync(join(dir, 'site.json'), 'utf8')).toContain(' ?');
  });

  it('lists and applies operations, then diffs', async () => {
    const dir = copy('salon');
    const list = await run(['ops', 'list']);
    expect((list.data as { operations: string[] }).operations).toContain('updateText');
    writeFileSync(join(dir, 'site.starter.json'), readFileSync(join(dir, 'site.json')));
    const op = JSON.stringify({
      op: 'updateText',
      path: ['pages', 0, 'blocks', 0, 'props', 'title'],
      locale: 'fr',
      value: 'Salon Lumière à Gustavia',
    });
    const applied = await run(['ops', 'apply', '--op', op, '--cwd', dir]);
    expect(applied).toMatchObject({ exitCode: EXIT.ok, data: { applied: true } });
    const diffed = await run(['diff', 'site.starter.json', '--cwd', dir]);
    expect((diffed.data as { summary: string }).summary).toMatch(/text/i);
    const refused = await run([
      'ops',
      'apply',
      '--op',
      JSON.stringify({ op: 'removePage', pageId: 'home' }),
      '--cwd',
      dir,
    ]);
    expect(refused.exitCode).toBe(EXIT.issues);
    const bad = await run(['ops', 'apply', '--op', '{"op":"nope"}', '--cwd', dir]);
    expect(bad.exitCode).toBe(EXIT.issues);
    expect(JSON.stringify(bad.data)).toContain('Unknown operation');
  });

  it('reads the catalog, facts and assets, and renders', async () => {
    const dir = copy('cafe');
    expect(((await run(['catalog', 'hero'])).data as { type: string }[])[0]?.type).toBe('hero');
    expect((await run(['catalog', 'carousel'])).exitCode).toBe(EXIT.usage);
    const phones = (await run(['facts', '--kind', 'phone', '--cwd', dir])).data as { kind: string }[];
    expect(phones.every((fact) => fact.kind === 'phone')).toBe(true);
    expect(Array.isArray((await run(['assets', '--role', 'image', '--cwd', dir])).data)).toBe(true);
  });

  it('answers usage errors with exit 2, and has help for every command', async () => {
    expect((await run(['nope'])).exitCode).toBe(EXIT.usage);
    expect((await run(['diff'])).exitCode).toBe(EXIT.usage);
    expect((await run(['screenshot'])).exitCode).toBe(EXIT.usage);
    expect((await run(['validate', '--cwd'])).exitCode).toBe(EXIT.usage);
    expect((await run(['validate', '--cwd', join(scratch, 'missing')])).exitCode).toBe(EXIT.usage);
    expect((await run(['lint-copy', '--cwd', copy('salon'), '--locale', 'xx'])).exitCode).toBe(EXIT.usage);
    expect((await run(['--version'])).human).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await run([])).human).toContain('Commands:');
    for (const command of Object.keys(HELP)) expect((await run(['help', command])).exitCode).toBe(EXIT.ok);
    expect((await run(['help', 'nope'])).exitCode).toBe(EXIT.usage);
    expect(parseArgs(['render', '--page', 'home', '--page', 'menu', '--json']).flags.get('page')).toEqual([
      'home',
      'menu',
    ]);
  });

  it('publishes the JSON Schemas it prints', () => {
    for (const [name, body] of outputSchemaFiles())
      expect(readFileSync(new URL(`../schemas/cli-output/${name}`, import.meta.url), 'utf8'), name).toBe(
        body,
      );
  });
});

describe('MCP server and Agent SDK tools', () => {
  async function connect(dir: string) {
    const workspace = await Workspace.open(dir);
    const server = createSitekitMcpServer(workspace);
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return { workspace, client, close: () => Promise.all([client.close(), server.close()]) };
  }

  it('exposes the eleven tools with annotations and no generic write or shell tool', async () => {
    const { client, close } = await connect(copy('salon'));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(SITEKIT_TOOLS.map((tool) => tool.name).sort());
      expect(tools).toHaveLength(11);
      expect(tools.find((tool) => tool.name === 'get_facts')?.annotations?.readOnlyHint).toBe(true);
      expect(tools.some((tool) => /write_file|shell|exec|bash/.test(tool.name))).toBe(false);
    } finally {
      await close();
    }
  });

  it('gives the same results as the library and the CLI (parity)', async () => {
    const dir = copy('broken');
    const { client, workspace, close } = await connect(dir);
    try {
      for (const [name, args] of [
        ['validate_site', {}],
        ['get_facts', { kind: 'phone' }],
        ['list_assets', {}],
        ['get_catalog', { block: 'hours' }],
      ] as const) {
        const viaMcp = await client.callTool({ name, arguments: args });
        const direct = await runTool({ workspace }, name, args);
        const text = (viaMcp.content as { type: string; text: string }[])[0]?.text ?? '';
        expect(JSON.parse(text), name).toEqual(JSON.parse(JSON.stringify(direct.data)));
        expect(Boolean(viaMcp.isError), name).toBe(direct.isError);
      }
      const cli = await run(['validate', '--cwd', dir]);
      expect(cli.data).toEqual((await runTool({ workspace }, 'validate_site', {})).data);
      const invalid = await client.callTool({ name: 'lint_copy', arguments: { locale: 'xx' } });
      expect(invalid.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('builds Agent SDK tools from the same definitions', async () => {
    const workspace = await Workspace.open(copy('salon'));
    const made: {
      name: string;
      handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
      annotations?: unknown;
    }[] = [];
    const tools = createSitekitAgentTools(workspace, (name, _description, _schema, handler, extras) => {
      const entry = { name, handler, annotations: extras?.annotations };
      made.push(entry);
      return entry;
    });
    expect(tools).toHaveLength(11);
    const validate = made.find((tool) => tool.name === 'validate_site');
    const result = (await validate?.handler({}, {})) as { content: { text: string }[]; isError: boolean };
    expect(JSON.parse(result.content[0]?.text ?? '{}').errors).toBe(0);
    expect(result.isError).toBe(false);
    expect(made.find((tool) => tool.name === 'check_done')?.annotations).toMatchObject({
      readOnlyHint: false,
    });
  });
});
