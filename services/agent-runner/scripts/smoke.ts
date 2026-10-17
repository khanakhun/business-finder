// Smoke test of the runner image (BF-043): the fake agent edits a fixture site through sitekit inside a hardened
// container, and `sitekit check` says done. The workspace goes in on stdin (no bind mount: works with a Docker that
// cannot read the host's /tmp). Usage: node services/agent-runner/scripts/smoke.ts [image]
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeRunnerStdin, parseRunnerFrame, type RunnerFrame } from '@bf/contracts/runner';
import { packBundle } from '../src/tar.ts';

const image = process.argv[2] ?? process.env.RUNNER_IMAGE ?? 'bf-agent-runner:dev';
const fixture = fileURLToPath(
  new URL('../../../packages/sitekit/fixtures/workspace-salon/', import.meta.url),
);

function files(dir: string, out = new Map<string, Buffer>()): Map<string, Buffer> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.sitekit') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files(path, out);
    else if (entry.isFile()) out.set(relative(fixture, path), readFileSync(path));
  }
  return out;
}

const stdin = encodeRunnerStdin(
  {
    protocol: 1,
    runId: 'smoke',
    command: ['node', '/opt/runner/fake-agent.mjs'],
    wallTimeSec: 120,
    collect: ['site.json', '.sitekit/screenshots/*.png'],
  },
  packBundle(files(fixture)),
);

const docker = spawn(
  'docker',
  [
    'run',
    '-i',
    '--rm',
    '--read-only',
    '--user',
    '10001:10001',
    '--tmpfs',
    '/workspace:rw,nosuid,nodev,noexec,size=512m,uid=10001,gid=10001',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,noexec,size=256m',
    '--tmpfs',
    '/home/agent:rw,nosuid,nodev,noexec,size=128m,uid=10001,gid=10001',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '512',
    '--memory',
    '4g',
    '--memory-swap',
    '4g',
    '--cpus',
    '2',
    '--network',
    'none',
    '--label',
    'bf.sandbox=true',
    image,
  ],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);
for (const part of stdin) docker.stdin.write(part);
docker.stdin.end();

const frames: RunnerFrame[] = [];
let invalid = 0;
let rest = '';
docker.stdout.on('data', (chunk: Buffer) => {
  const lines = (rest + chunk.toString('utf8')).split('\n');
  rest = lines.pop() ?? '';
  for (const line of lines) {
    if (!line) continue;
    const frame = parseRunnerFrame(line);
    if (frame) frames.push(frame);
    else invalid++;
  }
});
const status = await new Promise<number>((resolve) => docker.on('close', (code) => resolve(code ?? 1)));

const fail = (message: string) => {
  console.error(`runner smoke: FAILED — ${message}`);
  for (const frame of frames) if (frame.t !== 'artifact') console.error(JSON.stringify(frame).slice(0, 400));
  process.exit(1);
};
const versions = frames.find((frame) => frame.t === 'versions');
const check = frames.find((frame) => frame.t === 'check');
const exit = frames.at(-1);
if (invalid) fail(`${invalid} malformed frame(s)`);
if (!versions) fail('no versions frame');
if (!frames.some((frame) => frame.t === 'engine' && frame.line.includes('file_change')))
  fail('the fake agent did not run');
if (check?.t !== 'check' || (check.report as { data?: { done?: boolean } } | null)?.data?.done !== true)
  fail(`sitekit check is not done: ${JSON.stringify(check)}`);
const site = frames.find((frame) => frame.t === 'artifact' && frame.name === 'site.json');
if (
  site?.t !== 'artifact' ||
  !Buffer.from(site.data, 'base64').toString().includes('Salon de coiffure à Gustavia')
)
  fail('site.json did not come back edited');
if (exit?.t !== 'exit' || exit.reason !== 'completed' || status !== 0)
  fail(`exit ${status}, ${JSON.stringify(exit)}`);
console.log(`runner smoke: OK — ${JSON.stringify(versions?.t === 'versions' ? versions.versions : {})}`);
