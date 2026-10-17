import { Duplex } from 'node:stream';
import type { RunnerFrame } from '@bf/contracts/runner';
import type { SandboxRunSpec } from '@bf/contracts/sandbox';
import { describe, expect, it } from 'vitest';
import { SandboxError } from '../../application/sandbox.ports.ts';
import { type ContainerState, createDemuxer, type DockerApi } from './docker-engine.ts';
import { containerConfig, DockerSandboxProvider } from './docker-sandbox.ts';

// The Docker sandbox provider (BF-043) against a fake Engine API: frames, typed errors, abort, cleanup, config.

const spec: SandboxRunSpec = {
  image: 'bf-agent-runner:dev',
  cpus: 2,
  memoryMb: 4096,
  pidsLimit: 512,
  tmpfsMb: { workspace: 512, tmp: 256, home: 128 },
  wallTimeSec: 60,
  egressProfile: 'models',
  labels: { 'bf.job': 'job-1', 'bf.attempt': '1', 'bf.org': 'org-1' },
};
const input = { protocol: 1 as const, runId: 'job-1:1', command: ['node', 'agent.mjs'], wallTimeSec: 60 };

const mux = (stream: 1 | 2, text: string) => {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};
const frame = (value: RunnerFrame) => `${JSON.stringify(value)}\n`;

/** A container that answers its stdin with scripted output. */
function fakeDocker(script: {
  output?: Buffer[];
  status?: number;
  state?: Partial<ContainerState>;
  createFails?: boolean;
  hang?: boolean;
}) {
  const calls: string[] = [];
  let stdin = Buffer.alloc(0);
  let finish: (status: number) => void = () => {};
  const waited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  let stream: Duplex | undefined;
  const api: DockerApi = {
    async createContainer(_name, config) {
      calls.push('create');
      if (script.createFails) throw new Error('daemon down');
      expect(config).toMatchObject({ Image: spec.image });
      return 'c1';
    },
    async attach() {
      calls.push('attach');
      stream = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          stdin = Buffer.concat([stdin, chunk]);
          callback();
        },
        final(callback) {
          if (!script.hang) {
            for (const part of script.output ?? []) stream?.push(part);
            stream?.push(null);
            finish(script.status ?? 0);
          }
          callback();
        },
      });
      return stream;
    },
    async start() {
      calls.push('start');
    },
    wait: () => waited,
    async kill(_id, signal) {
      calls.push(`kill:${signal}`);
      if (signal === 'SIGKILL' || !script.hang) {
        stream?.push(null);
        finish(137);
      }
    },
    async inspect() {
      return { running: false, exitCode: script.status ?? 0, oomKilled: false, ...script.state };
    },
    async remove() {
      calls.push('remove');
    },
    async imageExists(ref) {
      return ref === spec.image;
    },
    async listContainers() {
      return [];
    },
  };
  return { api, calls, stdin: () => stdin };
}

async function collect(provider: DockerSandboxProvider, signal = new AbortController().signal) {
  const frames: RunnerFrame[] = [];
  for await (const value of provider.run(spec, input, new Uint8Array([1, 2, 3]), signal)) frames.push(value);
  return frames;
}

describe('DockerSandboxProvider', () => {
  it('feeds the input and bundle on stdin, yields the frames and removes the container', async () => {
    const fake = fakeDocker({
      output: [
        mux(
          1,
          `${frame({ t: 'versions', protocol: 1, versions: { node: 'v24' } })}{"t":"engine","line":"hel`,
        ),
        mux(1, 'lo"}\nnot a frame\n'),
        mux(2, 'supervisor noise\n'),
        mux(1, frame({ t: 'exit', code: 0, reason: 'completed' })),
      ],
    });
    let frameErrors = 0;
    const finished: string[] = [];
    const provider = new DockerSandboxProvider(
      fake.api,
      { network: 'bf-sandbox', egressProxyUrl: 'http://egress-proxy:4750' },
      {
        started() {},
        finished: (outcome) => finished.push(outcome),
        frameError: () => frameErrors++,
      },
    );
    const frames = await collect(provider);
    expect(frames.map((value) => value.t)).toEqual(['versions', 'engine', 'exit']);
    expect(frames[1]).toEqual({ t: 'engine', line: 'hello' });
    expect(frameErrors).toBe(1);
    expect(fake.calls).toEqual(['create', 'attach', 'start', 'remove']);
    const [line, length] = fake.stdin().toString('latin1').split('\n');
    expect(JSON.parse(line as string)).toMatchObject({ runId: 'job-1:1', command: ['node', 'agent.mjs'] });
    expect(length).toBe('3');
    expect(finished).toEqual(['completed']);
  });

  it('types the failures: unavailable, OOM, crash, protocol', async () => {
    await expect(
      collect(new DockerSandboxProvider(fakeDocker({ createFails: true }).api, { network: 'none' })),
    ).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    });
    const oom = fakeDocker({
      output: [mux(1, frame({ t: 'engine', line: 'x' }))],
      status: 137,
      state: { oomKilled: true },
    });
    await expect(collect(new DockerSandboxProvider(oom.api, { network: 'none' }))).rejects.toMatchObject({
      code: 'SANDBOX_OOM',
    });
    expect(oom.calls).toContain('remove');
    const crash = fakeDocker({ output: [mux(2, 'segfault\n')], status: 139 });
    await expect(collect(new DockerSandboxProvider(crash.api, { network: 'none' }))).rejects.toThrow(
      /exited with 139.*segfault/,
    );
    const silent = fakeDocker({ output: [], status: 0 });
    await expect(collect(new DockerSandboxProvider(silent.api, { network: 'none' }))).rejects.toMatchObject({
      code: 'SANDBOX_PROTOCOL_ERROR',
    });
  });

  it('stops on abort (SIGTERM, then SIGKILL after the grace) and still removes the container', async () => {
    const fake = fakeDocker({ hang: true });
    const controller = new AbortController();
    const provider = new DockerSandboxProvider(fake.api, { network: 'none', killGraceMs: 20 });
    setTimeout(() => controller.abort(), 20);
    expect(await collect(provider, controller.signal)).toEqual([]);
    expect(fake.calls).toEqual(['create', 'attach', 'start', 'kill:SIGTERM', 'kill:SIGKILL', 'remove']);
  });

  it('stops a container that outlives its wall time, as a timeout', async () => {
    const fake = fakeDocker({ hang: true });
    const provider = new DockerSandboxProvider(fake.api, {
      network: 'none',
      killGraceMs: 10,
      watchdogMarginMs: 0,
    });
    const short = { ...spec, wallTimeSec: 0 } as SandboxRunSpec;
    const run = async () => {
      for await (const _ of provider.run(short, input, new Uint8Array(), new AbortController().signal))
        void _;
    };
    await expect(run()).rejects.toBeInstanceOf(SandboxError);
    await expect(run()).rejects.toMatchObject({ code: 'SANDBOX_TIMEOUT' });
  });

  it('reports readiness from the image', async () => {
    const provider = new DockerSandboxProvider(fakeDocker({}).api, { network: 'none' });
    expect(await provider.ready(spec.image)).toEqual({ ready: true });
    expect((await provider.ready('other:tag')).ready).toBe(false);
  });
});

describe('containerConfig', () => {
  it('is hardened: read-only root, no capabilities, limits, tmpfs, no mounts, proxy only with egress', () => {
    const config = containerConfig(spec, {
      network: 'bf-sandbox',
      egressProxyUrl: 'http://egress-proxy:4750',
    }) as {
      User: string;
      Env: string[];
      Labels: Record<string, string>;
      HostConfig: Record<string, unknown>;
    };
    expect(config.User).toBe('10001:10001');
    expect(config.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: 512,
      Memory: 4096 * 1024 * 1024,
      MemorySwap: 4096 * 1024 * 1024,
      NanoCpus: 2e9,
      Privileged: false,
      NetworkMode: 'bf-sandbox',
      Binds: [],
      Devices: [],
    });
    expect((config.HostConfig.Tmpfs as Record<string, string>)['/workspace']).toMatch(
      /noexec.*size=512m.*uid=10001/,
    );
    expect(config.Env).toContain('HTTPS_PROXY=http://egress-proxy:4750');
    expect(config.Labels).toMatchObject({ 'bf.sandbox': 'true', 'bf.job': 'job-1' });
    const offline = containerConfig(
      { ...spec, egressProfile: 'none' },
      { network: 'bf-sandbox', egressProxyUrl: 'http://egress-proxy:4750' },
    ) as {
      Env: string[];
      NetworkDisabled: boolean;
      HostConfig: { NetworkMode: string };
    };
    expect(offline).toMatchObject({ Env: [], NetworkDisabled: true, HostConfig: { NetworkMode: 'none' } });
  });
});

describe('createDemuxer', () => {
  it('splits stdout and stderr across arbitrary chunk boundaries', () => {
    const out: string[] = [];
    const err: string[] = [];
    const demux = createDemuxer(
      (chunk) => out.push(chunk.toString()),
      (chunk) => err.push(chunk.toString()),
    );
    const all = Buffer.concat([mux(1, 'one'), mux(2, 'two'), mux(1, 'three')]);
    for (let i = 0; i < all.length; i += 5) demux(all.subarray(i, i + 5));
    expect(out).toEqual(['one', 'three']);
    expect(err).toEqual(['two']);
  });
});
