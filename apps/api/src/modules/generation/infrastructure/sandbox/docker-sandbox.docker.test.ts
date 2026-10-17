import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerFrame } from '@bf/contracts/runner';
import type { SandboxRunSpec } from '@bf/contracts/sandbox';
import { describe, expect, it } from 'vitest';
import { packBundle } from '../workspace/tar.ts';
import { HttpDockerApi } from './docker-engine.ts';
import { DockerSandboxProvider } from './docker-sandbox.ts';

// The Docker provider against a real daemon and the runner image (BF-043). Runs when DOCKER_SANDBOX_IMAGE names a
// built image (the CI runner job; locally `pnpm runner:build` then DOCKER_SANDBOX_IMAGE=bf-agent-runner:dev).

const image = process.env.DOCKER_SANDBOX_IMAGE;
const host = process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock';
const fixture = fileURLToPath(
  new URL('../../../../../../../packages/sitekit/fixtures/workspace-salon/', import.meta.url),
);

function bundle(): Uint8Array {
  const files = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.sitekit') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.set(relative(fixture, path), readFileSync(path));
    }
  };
  walk(fixture);
  return packBundle(files);
}

const spec = (overrides: Partial<SandboxRunSpec> = {}): SandboxRunSpec => ({
  image: image ?? 'none',
  cpus: 2,
  memoryMb: 2048,
  pidsLimit: 512,
  tmpfsMb: { workspace: 256, tmp: 128, home: 64 },
  wallTimeSec: 120,
  egressProfile: 'none',
  labels: { 'bf.job': 'docker-test', 'bf.attempt': '1', 'bf.org': 'test' },
  ...overrides,
});

describe.runIf(Boolean(image))('DockerSandboxProvider on a real daemon', () => {
  const provider = new DockerSandboxProvider(new HttpDockerApi(host), { network: 'none', killGraceMs: 2000 });

  it('runs the fake agent to a done check in a hardened container, and removes it', async () => {
    expect(await provider.ready(image as string)).toEqual({ ready: true });
    const frames: RunnerFrame[] = [];
    for await (const frame of provider.run(
      spec(),
      {
        protocol: 1,
        runId: `docker-test-${Date.now()}`,
        command: ['node', '/opt/runner/fake-agent.mjs'],
        wallTimeSec: 120,
      },
      bundle(),
      new AbortController().signal,
    ))
      frames.push(frame);
    expect(frames[0]).toMatchObject({ t: 'versions' });
    expect(frames.find((frame) => frame.t === 'check')).toMatchObject({
      exitCode: 0,
      report: { data: { done: true } },
    });
    expect(frames.at(-1)).toMatchObject({ t: 'exit', reason: 'completed' });
    const left = await new HttpDockerApi(host).listContainers(['bf.job=docker-test']);
    expect(left).toEqual([]);
  }, 120_000);

  it('maps an out-of-memory kill to SANDBOX_OOM', async () => {
    const run = async () => {
      for await (const _ of provider.run(
        spec({ memoryMb: 256 }),
        {
          protocol: 1,
          runId: `docker-oom-${Date.now()}`,
          command: [
            'node',
            '--max-old-space-size=4096',
            '-e',
            'const a=[];for(;;)a.push(Buffer.alloc(16*1024*1024,1))',
          ],
          wallTimeSec: 60,
          checkCommand: ['true'],
        },
        bundle(),
        new AbortController().signal,
      ))
        void _;
    };
    await expect(run()).rejects.toMatchObject({ code: expect.stringMatching(/SANDBOX_OOM|SANDBOX_CRASH/) });
  }, 120_000);

  it('stops a run on abort and removes the container', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    const frames: RunnerFrame[] = [];
    for await (const frame of provider.run(
      spec(),
      {
        protocol: 1,
        runId: `docker-abort-${Date.now()}`,
        command: ['node', '-e', 'setInterval(()=>{},1000)'],
        wallTimeSec: 120,
      },
      bundle(),
      controller.signal,
    ))
      frames.push(frame);
    expect(frames.some((frame) => frame.t === 'check')).toBe(false);
    expect(await new HttpDockerApi(host).listContainers(['bf.job=docker-test'])).toEqual([]);
  }, 60_000);
});
