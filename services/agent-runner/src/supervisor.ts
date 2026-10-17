import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { glob, readFile, realpath, stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import {
  ARTIFACT_CHUNK_BYTES,
  type ParsedRunnerInput,
  RUNNER_PROTOCOL,
  type RunnerExitReason,
  type RunnerFrame,
} from '@bf/contracts/runner';
import { createRedactor } from './redact.ts';
import { BundleError, extractBundle } from './tar.ts';

// The supervisor (BF-043): unpack the workspace, run the agent's command in its own process group with the run's
// environment (secrets only there), forward its output as frames (redacted), keep a heartbeat, enforce the wall time,
// run the check, send the collected files back, and say how it ended. It never runs anything the input did not name.

export const HEARTBEAT_MS = 10_000;
export const KILL_GRACE_MS = 10_000;
const MAX_LINE = 64 * 1024;
/** Bytes the bundle may expand to (the workspace tmpfs is 512 MB). */
const MAX_EXTRACTED = 256 * 1024 * 1024;

export interface SupervisorDeps {
  readonly workspace: string;
  /** Environment of the image (PATH, HOME, proxies…): the child gets it plus the input's `env`. */
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly emit: (frame: RunnerFrame) => Promise<void> | void;
  readonly versions: () => Promise<Record<string, string>>;
  readonly now?: () => Date;
  readonly heartbeatMs?: number;
  readonly killGraceMs?: number;
  /** Aborted from outside (SIGTERM to the supervisor). */
  readonly signal?: AbortSignal;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** Runs a command to completion, streaming its lines; resolves with its exit code (or the signal as 128+n). */
function runCommand(
  argv: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    onStdout: (line: string) => void;
    onStderr: (line: string) => void;
  },
): { child: ChildProcess; done: Promise<number> } {
  const [program, ...args] = argv as [string, ...string[]];
  const child = spawn(program, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = (stream: Readable | null, onLine: (line: string) => void) => {
    if (!stream) return Promise.resolve();
    const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    reader.on('line', (line) =>
      onLine(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…[truncated]` : line),
    );
    return new Promise<void>((resolve) => reader.on('close', resolve));
  };
  const out = lines(child.stdout, options.onStdout);
  const err = lines(child.stderr, options.onStderr);
  const done = new Promise<number>((resolve) => {
    child.on('error', (error) => {
      options.onStderr(`supervisor: cannot start ${program}: ${error.message}`);
      resolve(127);
    });
    child.on('close', async (code, signal) => {
      await Promise.all([out, err]);
      resolve(code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 1));
    });
  });
  return { child, done };
}

const SIGNALS: Partial<Record<NodeJS.Signals, number>> = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2 };
const signalNumber = (signal: NodeJS.Signals) => SIGNALS[signal];

/** Files matching the input's globs, inside the workspace, regular files only. */
async function collectFiles(workspace: string, patterns: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  const root = await realpath(workspace);
  for (const pattern of patterns) {
    if (pattern.startsWith('/') || pattern.split('/').includes('..')) continue;
    for await (const match of glob(pattern, { cwd: root })) {
      const absolute = await realpath(`${root}${sep}${match}`).catch(() => undefined);
      if (!absolute) continue;
      const rel = relative(root, absolute);
      if (rel.startsWith('..') || rel === '') continue;
      if ((await stat(absolute)).isFile()) found.add(rel);
    }
  }
  return [...found].sort();
}

export async function supervise(
  input: ParsedRunnerInput,
  bundle: Buffer,
  deps: SupervisorDeps,
): Promise<{ code: number; reason: RunnerExitReason }> {
  const now = deps.now ?? (() => new Date());
  const secretValues = input.secrets.flatMap((name) => (input.env[name] ? [input.env[name] as string] : []));
  const redact = createRedactor(secretValues);
  const emit = async (frame: RunnerFrame) => deps.emit(frame);
  const exit = async (code: number, reason: RunnerExitReason, message?: string) => {
    await emit({ t: 'exit', code, reason, ...(message ? { message: redact(message).slice(0, 2000) } : {}) });
    return { code, reason };
  };

  try {
    await extractBundle(bundle, deps.workspace, MAX_EXTRACTED);
  } catch (error) {
    if (error instanceof BundleError) return exit(1, 'workspace_invalid', error.message);
    throw error;
  }
  await emit({ t: 'versions', protocol: RUNNER_PROTOCOL, versions: await deps.versions() });

  const pending: Promise<void>[] = [];
  const forward = (t: 'engine' | 'stderr') => (line: string) => {
    pending.push(Promise.resolve(emit({ t, line: redact(line) })));
  };
  const heartbeat = setInterval(() => {
    pending.push(Promise.resolve(emit({ t: 'heartbeat', at: now().toISOString() })));
  }, deps.heartbeatMs ?? HEARTBEAT_MS);
  const childEnv = { ...deps.baseEnv, ...input.env };
  const { child, done } = runCommand(input.command, {
    cwd: deps.workspace,
    env: childEnv,
    onStdout: forward('engine'),
    onStderr: forward('stderr'),
  });

  let ending: RunnerExitReason | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  const stop = (reason: RunnerExitReason) => {
    if (ending) return;
    ending = reason;
    killGroup(child, 'SIGTERM');
    graceTimer = setTimeout(() => killGroup(child, 'SIGKILL'), deps.killGraceMs ?? KILL_GRACE_MS);
  };
  const wallTimer = setTimeout(() => stop('timeout'), input.wallTimeSec * 1000);
  const onAbort = () => stop('killed');
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  const code = await done;
  clearTimeout(wallTimer);
  clearTimeout(graceTimer);
  clearInterval(heartbeat);
  deps.signal?.removeEventListener('abort', onAbort);
  await Promise.all(pending);
  if (ending === 'killed') return exit(code, 'killed', 'Stopped from outside (SIGTERM).');

  // The check runs without the run's secrets: it needs none.
  const checkEnv = { ...deps.baseEnv };
  let checkOutput = '';
  const check = runCommand(input.checkCommand, {
    cwd: deps.workspace,
    env: checkEnv,
    onStdout: (line) => {
      checkOutput += `${line}\n`;
    },
    onStderr: (line) => pending.push(Promise.resolve(emit({ t: 'stderr', line: redact(`check: ${line}`) }))),
  });
  const checkTimer = setTimeout(() => killGroup(check.child, 'SIGKILL'), 120_000);
  const checkCode = await check.done;
  clearTimeout(checkTimer);
  await Promise.all(pending);
  let report: unknown = null;
  try {
    report = JSON.parse(checkOutput.trim().split('\n').at(-1) ?? 'null');
  } catch {
    report = null;
  }
  await emit({ t: 'check', exitCode: checkCode, report });

  let budget = input.limits.maxArtifactBytes;
  for (const name of await collectFiles(deps.workspace, input.collect)) {
    const data = await readFile(`${deps.workspace}${sep}${name}`);
    if (data.length > budget) {
      await emit({
        t: 'stderr',
        line: `supervisor: ${name} (${data.length} bytes) skipped: over the artifact budget.`,
      });
      continue;
    }
    budget -= data.length;
    const sha256 = createHash('sha256').update(data).digest('hex');
    const chunks = Math.max(1, Math.ceil(data.length / ARTIFACT_CHUNK_BYTES));
    for (let seq = 0; seq < chunks; seq++)
      await emit({
        t: 'artifact',
        name,
        sha256,
        bytes: data.length,
        seq,
        last: seq === chunks - 1,
        data: data.subarray(seq * ARTIFACT_CHUNK_BYTES, (seq + 1) * ARTIFACT_CHUNK_BYTES).toString('base64'),
      });
  }
  if (ending === 'timeout')
    return exit(code, 'timeout', `The run exceeded its wall time (${input.wallTimeSec} s).`);
  return exit(code, code === 0 ? 'completed' : 'failed');
}
