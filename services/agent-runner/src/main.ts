import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { RunnerFrame } from '@bf/contracts/runner';
import { seedHome } from './home.ts';
import { InputError, readRunnerStdin } from './input.ts';
import { supervise } from './supervisor.ts';

// The runner's PID 1 under tini (BF-043): stdin → supervise → frames on stdout. Exit 0 when the run completed.

const run = promisify(execFile);
const WORKSPACE = process.env.BF_WORKSPACE ?? '/workspace';

async function version(command: string, args: string[] = ['--version']): Promise<string> {
  try {
    const { stdout } = await run(command, args, { timeout: 5000 });
    return stdout.trim().split('\n')[0]?.slice(0, 200) || 'unknown';
  } catch {
    return 'unavailable';
  }
}

const write = (frame: RunnerFrame) =>
  new Promise<void>((resolve) => {
    if (process.stdout.write(`${JSON.stringify(frame)}\n`)) resolve();
    else process.stdout.once('drain', () => resolve());
  });

async function main() {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  let input: Awaited<ReturnType<typeof readRunnerStdin>>;
  try {
    input = await readRunnerStdin(process.stdin);
  } catch (error) {
    await write({
      t: 'exit',
      code: 2,
      reason: 'input_invalid',
      message: error instanceof InputError ? error.message : 'Unreadable input.',
    });
    process.exitCode = 2;
    return;
  }
  if (process.env.HOME) await seedHome(new URL('./home', import.meta.url).pathname, process.env.HOME);
  const env = { ...process.env };
  delete env.BF_WORKSPACE;
  const result = await supervise(input.input, input.bundle, {
    workspace: WORKSPACE,
    baseEnv: env,
    emit: write,
    signal: controller.signal,
    versions: async () => ({
      node: process.version,
      claude: await version('claude'),
      codex: await version('codex'),
      sitekit: await version('sitekit'),
      chromium: await readFile('/opt/sitekit/chromium-version', 'utf8').then(
        (text) => text.trim(),
        () => 'unknown',
      ),
      runner: process.env.BF_RUNNER_VERSION ?? 'dev',
    }),
  });
  process.exitCode = result.reason === 'completed' ? 0 : 1;
}

main().catch(async (error: unknown) => {
  await write({
    t: 'exit',
    code: 3,
    reason: 'internal',
    message: error instanceof Error ? error.message.slice(0, 500) : 'internal error',
  });
  process.exitCode = 3;
});
