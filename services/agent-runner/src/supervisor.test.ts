import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { zstdCompressSync } from 'node:zlib';
import {
  encodeRunnerStdin,
  type RunnerFrame,
  RunnerFrameSchema,
  RunnerInputSchema,
} from '@bf/contracts/runner';
import { afterAll, describe, expect, it } from 'vitest';
import { InputError, readRunnerStdin } from './input.ts';
import { createRedactor, REDACTED } from './redact.ts';
import { supervise } from './supervisor.ts';
import { BundleError, extractBundle, packBundle, readTar, safeTarget } from './tar.ts';

// The supervisor (BF-043) with real processes: frames, redaction, wall time, abort, check, artifacts, and the
// workspace bundle read safely.

const scratch = mkdtempSync(join(tmpdir(), 'agent-runner-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const dir = () => {
  const path = join(scratch, Math.random().toString(36).slice(2));
  mkdirSync(path, { recursive: true });
  return path;
};

const node = (code: string) => ['node', '-e', code];
const input = (overrides: Record<string, unknown> = {}) =>
  RunnerInputSchema.parse({
    protocol: 1,
    runId: 'run-1',
    command: node('console.log("hi")'),
    wallTimeSec: 30,
    checkCommand: node('console.log(JSON.stringify({ command: "check", ok: true, data: { done: true } }))'),
    ...overrides,
  });

async function runIt(options: {
  input?: ReturnType<typeof input>;
  files?: Map<string, string>;
  signal?: AbortSignal;
  killGraceMs?: number;
  heartbeatMs?: number;
}) {
  const frames: RunnerFrame[] = [];
  const workspace = dir();
  const bundle = packBundle(
    options.files ??
      new Map([
        ['site.json', '{"a":1}\n'],
        ['brief.json', '{}'],
      ]),
  );
  const result = await supervise(options.input ?? input(), bundle, {
    workspace,
    baseEnv: { PATH: process.env.PATH ?? '' },
    emit: (frame) => {
      frames.push(RunnerFrameSchema.parse(frame));
    },
    versions: async () => ({ node: process.version }),
    heartbeatMs: options.heartbeatMs ?? 60_000,
    killGraceMs: options.killGraceMs ?? 200,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { frames, result, workspace };
}

describe('supervise', () => {
  it('runs the command, then the check, sends artifacts and exits', async () => {
    const { frames, result } = await runIt({
      input: input({
        command: node(
          'const fs=require("fs");console.log("line one");console.error("oops");fs.writeFileSync("site.json",JSON.stringify({b:2}))',
        ),
        collect: ['site.json', 'missing/*.png'],
      }),
    });
    expect(result).toEqual({ code: 0, reason: 'completed' });
    expect(frames.map((frame) => frame.t)).toEqual([
      'versions',
      'engine',
      'stderr',
      'check',
      'artifact',
      'exit',
    ]);
    expect(frames.find((frame) => frame.t === 'engine')).toMatchObject({ line: 'line one' });
    expect(frames.find((frame) => frame.t === 'check')).toMatchObject({
      exitCode: 0,
      report: { data: { done: true } },
    });
    const artifact = frames.find((frame) => frame.t === 'artifact');
    expect(artifact).toMatchObject({ name: 'site.json', seq: 0, last: true });
    expect(Buffer.from((artifact as { data: string }).data, 'base64').toString()).toBe('{"b":2}');
  });

  it('applies the env to the child only and redacts its secrets everywhere', async () => {
    // Key-shaped strings are assembled at run time: none sits in the source for secret scanners to flag.
    const secret = ['sk', 'ant', 'api03', 'supersecretvalue123'].join('-');
    const { frames } = await runIt({
      input: input({
        command: node(
          'console.log("key="+process.env.ANTHROPIC_API_KEY);console.error(process.env.ANTHROPIC_API_KEY);console.log(process.env.OTHER)',
        ),
        env: { ANTHROPIC_API_KEY: secret, OTHER: 'plain' },
        secrets: ['ANTHROPIC_API_KEY'],
        checkCommand: node('console.log(JSON.stringify({ key: process.env.ANTHROPIC_API_KEY ?? null }))'),
      }),
    });
    const text = JSON.stringify(frames);
    expect(text).not.toContain('supersecretvalue');
    expect(frames.find((frame) => frame.t === 'engine')).toMatchObject({ line: `key=${REDACTED}` });
    expect(frames.some((frame) => frame.t === 'engine' && frame.line === 'plain')).toBe(true);
    expect(frames.find((frame) => frame.t === 'check')).toMatchObject({ report: { key: null } });
  });

  it('enforces the wall time: SIGTERM, then SIGKILL', async () => {
    const started = Date.now();
    const { frames, result } = await runIt({
      input: input({
        command: node('process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'),
        wallTimeSec: 10,
      }),
      killGraceMs: 100,
      heartbeatMs: 50,
    });
    expect(result.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(frames.some((frame) => frame.t === 'heartbeat')).toBe(true);
    expect(frames.at(-1)).toMatchObject({ t: 'exit', reason: 'timeout' });
  }, 20_000);

  it('stops on an outside SIGTERM and reports it', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const { result, frames } = await runIt({
      input: input({ command: node('setInterval(()=>{},1000)') }),
      signal: controller.signal,
    });
    expect(result.reason).toBe('killed');
    expect(frames.some((frame) => frame.t === 'check')).toBe(false);
  });

  it('reports a failed command, and keeps artifacts within the budget', async () => {
    const big = 'x'.repeat(300 * 1024);
    const { frames, result } = await runIt({
      input: input({
        command: node(
          `require("fs").writeFileSync("big.txt","${'y'.repeat(10)}".repeat(30*1024));process.exit(3)`,
        ),
        collect: ['*.txt', 'site.json'],
        limits: { maxArtifactBytes: 200 * 1024, maxBundleBytes: 1024 * 1024 },
      }),
      files: new Map([['site.json', big]]),
    });
    expect(result).toEqual({ code: 3, reason: 'failed' });
    const artifacts = frames.filter((frame) => frame.t === 'artifact');
    expect(artifacts).toEqual([]);
    expect(
      frames.filter((frame) => frame.t === 'stderr' && frame.line.includes('over the artifact budget')),
    ).toHaveLength(2);
  });

  it('chunks large artifacts', async () => {
    const big = 'z'.repeat(600 * 1024);
    const { frames } = await runIt({ files: new Map([['site.json', big]]) });
    const chunks = frames.filter((frame) => frame.t === 'artifact');
    expect(chunks.map((chunk) => (chunk as { seq: number }).seq)).toEqual([0, 1, 2]);
    expect(chunks.at(-1)).toMatchObject({ last: true, bytes: big.length });
  });

  it('refuses a workspace bundle with a link or a path outside', async () => {
    const frames: RunnerFrame[] = [];
    const result = await supervise(input(), zstdCompressSync(Buffer.from('not a tar')), {
      workspace: dir(),
      baseEnv: {},
      emit: (frame) => {
        frames.push(frame);
      },
      versions: async () => ({}),
    });
    expect(result.reason).toBe('workspace_invalid');
    expect(frames).toEqual([expect.objectContaining({ t: 'exit', reason: 'workspace_invalid' })]);
  });
});

describe('the bundle', () => {
  it('extracts plain files without exec bits, and refuses traversal, absolute paths and links', async () => {
    const root = dir();
    expect(
      await extractBundle(
        packBundle(
          new Map([
            ['a/b.json', '{}'],
            ['c.md', '#'],
          ]),
        ),
        root,
        1024 * 1024,
      ),
    ).toBe(2);
    expect(readFileSync(join(root, 'a/b.json'), 'utf8')).toBe('{}');
    for (const path of ['../escape', '/etc/passwd', 'a/../../x', 'C:/x'])
      expect(() => safeTarget(root, path)).toThrow(BundleError);
    // A symbolic link entry (type 2) is refused.
    const tar = Buffer.from(require_untar_link());
    expect(() => readTar(tar)).toThrow(/links are refused/);
    // A link planted in the workspace is not written through.
    const planted = dir();
    symlinkSync(join(scratch), join(planted, 'site.json'));
    await expect(extractBundle(packBundle(new Map([['site.json', 'x']])), planted, 1024)).rejects.toThrow();
    await expect(
      extractBundle(packBundle(new Map([['big', 'x'.repeat(5000)]])), dir(), 1024),
    ).rejects.toThrow(BundleError);
  });
});

/** A one-entry tar whose entry is a symbolic link. */
function require_untar_link(): Buffer {
  const tar = Buffer.from(Buffer.concat([Buffer.alloc(512), Buffer.alloc(1024)]));
  tar.write('evil', 0);
  tar.write('0000644\0', 100);
  tar.write('0000000\0', 108);
  tar.write('0000000\0', 116);
  tar.write('00000000000\0', 124);
  tar.write('00000000000\0', 136);
  tar.fill(0x20, 148, 156);
  tar.write('2', 156);
  tar.write('/etc/passwd', 157);
  tar.write('ustar\0', 257);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += tar[i] as number;
  tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return tar;
}

describe('stdin', () => {
  const stream = (...parts: (string | Uint8Array)[]) => Readable.from(parts.map((part) => Buffer.from(part)));

  it('reads the input line, the length line and the bundle, in any chunking', async () => {
    const bundle = packBundle(new Map([['site.json', '{}']]));
    const encoded = Buffer.concat(encodeRunnerStdin(input(), bundle));
    const pieces = [encoded.subarray(0, 7), encoded.subarray(7, 90), encoded.subarray(90)];
    const read = await readRunnerStdin(stream(...pieces));
    expect(read.input.runId).toBe('run-1');
    expect(read.bundle.equals(bundle)).toBe(true);
  });

  it('refuses malformed input', async () => {
    await expect(readRunnerStdin(stream('nope\n'))).rejects.toThrow(InputError);
    await expect(readRunnerStdin(stream('{"protocol":2}\n'))).rejects.toThrow(/Invalid RunnerInput/);
    const line = `${JSON.stringify(input())}\n`;
    await expect(readRunnerStdin(stream(line, 'abc\n'))).rejects.toThrow(/bundle length/);
    await expect(readRunnerStdin(stream(line, '10\n', '123'))).rejects.toThrow(/3 bytes; 10 were declared/);
    await expect(readRunnerStdin(stream(line, '2\n', '123'))).rejects.toThrow(/More bytes/);
    await expect(readRunnerStdin(stream(line, '99999999999\n'))).rejects.toThrow(/larger than/);
    await expect(readRunnerStdin(stream(line))).rejects.toThrow(/ended before/);
  });
});

describe('redact', () => {
  it('hides declared secrets and anything shaped like a provider key', () => {
    const redact = createRedactor(['my-secret-value', 'short']);
    expect(redact('a my-secret-value b')).toBe(`a ${REDACTED} b`);
    expect(redact('short stays')).toBe('short stays');
    expect(
      redact(
        `key ${['sk', 'ant', 'api03', 'abcdefghijklmnop'].join('-')} and ${['sk', 'proj', 'abcdefghijklmnopqrstuvwx'].join('-')}`,
      ),
    ).toBe(`key ${REDACTED} and ${REDACTED}`);
    expect(redact(`${'AKIA'}${'ABCDEFGHIJKLMNOP'}`)).toBe(REDACTED);
    writeFileSync(join(scratch, 'noop'), '');
  });
});
