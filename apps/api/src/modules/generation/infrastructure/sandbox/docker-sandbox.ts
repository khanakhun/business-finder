import {
  encodeRunnerStdin,
  parseRunnerFrame,
  type RunnerFrame,
  type RunnerInput,
} from '@bf/contracts/runner';
import type { SandboxRunSpec } from '@bf/contracts/sandbox';
import {
  SandboxError,
  type SandboxProvider,
  type SandboxTelemetry,
} from '../../application/sandbox.ports.ts';
import { createDemuxer, type DockerApi } from './docker-engine.ts';

// The Docker sandbox (BF-043): one hardened container per run — read-only root, tmpfs workspace, no capabilities, no
// new privileges, pids/memory/CPU limits, no mounts or devices, the internal sandbox network behind the egress proxy
// (or no network) — fed on stdin, read on stdout, always removed. Abort: SIGTERM, 10 s, SIGKILL.

export const KILL_GRACE_MS = 10_000;
/** Beyond the run's own wall time (the supervisor's), how long before the container is stopped from outside. */
export const WATCHDOG_MARGIN_MS = 60_000;
const STDERR_TAIL = 20;

export interface DockerSandboxOptions {
  /** The sandbox network (`bf-sandbox`, internal); `none` runs without any network. */
  readonly network: string;
  /** The egress proxy sandboxes reach the allowed hosts through (unset: no proxy variables). */
  readonly egressProxyUrl?: string;
  readonly killGraceMs?: number;
  readonly watchdogMarginMs?: number;
}

const noopTelemetry: SandboxTelemetry = { started() {}, finished() {}, frameError() {} };

export function containerConfig(
  spec: SandboxRunSpec,
  options: DockerSandboxOptions,
): Record<string, unknown> {
  const offline = spec.egressProfile === 'none' || options.network === 'none';
  const proxy = !offline && options.egressProxyUrl;
  const tmpfs = (size: number, owned: boolean) =>
    `rw,nosuid,nodev,noexec,size=${size}m${owned ? ',uid=10001,gid=10001,mode=0700' : ''}`;
  return {
    Image: spec.image,
    User: '10001:10001',
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    Env: proxy
      ? [
          `HTTPS_PROXY=${proxy}`,
          `HTTP_PROXY=${proxy}`,
          `https_proxy=${proxy}`,
          `http_proxy=${proxy}`,
          'NO_PROXY=127.0.0.1,localhost',
          'no_proxy=127.0.0.1,localhost',
        ]
      : [],
    Labels: { ...spec.labels, 'bf.sandbox': 'true', 'bf.wall_time_sec': String(spec.wallTimeSec) },
    NetworkDisabled: offline,
    HostConfig: {
      ReadonlyRootfs: true,
      Tmpfs: {
        '/workspace': tmpfs(spec.tmpfsMb.workspace, true),
        '/tmp': tmpfs(spec.tmpfsMb.tmp, false),
        '/home/agent': tmpfs(spec.tmpfsMb.home, true),
      },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: spec.pidsLimit,
      Memory: spec.memoryMb * 1024 * 1024,
      MemorySwap: spec.memoryMb * 1024 * 1024,
      NanoCpus: Math.round(spec.cpus * 1e9),
      Init: false,
      Privileged: false,
      NetworkMode: offline ? 'none' : options.network,
      AutoRemove: false,
      Binds: [],
      Devices: [],
      // Frames reach the worker through attach; nothing (not even redacted lines) is kept in Docker's logs.
      LogConfig: { Type: 'none', Config: {} },
    },
  };
}

/** A push-to-pull queue: the container's events in, the generator's frames out. */
class FrameQueue {
  private readonly items: RunnerFrame[] = [];
  private waiting: (() => void) | undefined;
  closed = false;
  push(frame: RunnerFrame) {
    this.items.push(frame);
    this.wake();
  }
  close() {
    this.closed = true;
    this.wake();
  }
  private wake() {
    this.waiting?.();
    this.waiting = undefined;
  }
  async *drain(): AsyncGenerator<RunnerFrame> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly id = 'docker';

  constructor(
    private readonly api: DockerApi,
    private readonly options: DockerSandboxOptions,
    private readonly telemetry: SandboxTelemetry = noopTelemetry,
  ) {}

  async ready(image: string) {
    try {
      return (await this.api.imageExists(image))
        ? { ready: true }
        : {
            ready: false,
            reason: `The runner image ${image} is not present (pull it before starting workers).`,
          };
    } catch (error) {
      return { ready: false, reason: `Docker is unreachable: ${(error as Error).message}` };
    }
  }

  async *run(
    spec: SandboxRunSpec,
    input: RunnerInput,
    bundle: Uint8Array,
    signal: AbortSignal,
  ): AsyncGenerator<RunnerFrame> {
    const started = performance.now();
    const name = `bf-run-${input.runId.replace(/[^A-Za-z0-9_.-]/g, '-')}`.slice(0, 120);
    let id: string;
    try {
      id = await this.api.createContainer(name, containerConfig(spec, this.options));
    } catch (error) {
      throw new SandboxError(
        'SANDBOX_UNAVAILABLE',
        `The sandbox could not be created: ${(error as Error).message}`,
      );
    }
    this.telemetry.started();
    const queue = new FrameQueue();
    const stderrTail: string[] = [];
    let sawExit = false;
    let invalid = 0;
    let outcome: Parameters<SandboxTelemetry['finished']>[0] = 'failed';
    let stopReason: 'aborted' | 'watchdog' | undefined;
    const timers: NodeJS.Timeout[] = [];
    const stop = (reason: 'aborted' | 'watchdog') => {
      if (stopReason) return;
      stopReason = reason;
      void this.api.kill(id, 'SIGTERM').catch(() => {});
      timers.push(
        setTimeout(
          () => void this.api.kill(id, 'SIGKILL').catch(() => {}),
          this.options.killGraceMs ?? KILL_GRACE_MS,
        ),
      );
    };
    const onAbort = () => stop('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    timers.push(
      setTimeout(
        () => stop('watchdog'),
        spec.wallTimeSec * 1000 + (this.options.watchdogMarginMs ?? WATCHDOG_MARGIN_MS),
      ),
    );

    try {
      const stream = await this.api.attach(id);
      let partial = '';
      const demux = createDemuxer(
        (chunk) => {
          const lines = (partial + chunk.toString('utf8')).split('\n');
          partial = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            const frame = parseRunnerFrame(line);
            if (!frame) {
              invalid++;
              this.telemetry.frameError();
              continue;
            }
            if (frame.t === 'exit') sawExit = true;
            queue.push(frame);
          }
        },
        (chunk) => {
          for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
            stderrTail.push(line.slice(0, 500));
            if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
          }
        },
      );
      const ended = new Promise<void>((resolve) => {
        stream.on('data', demux);
        stream.on('end', resolve);
        stream.on('close', resolve);
        stream.on('error', () => resolve());
      });
      await this.api.start(id);
      if (signal.aborted) stop('aborted');
      for (const part of encodeRunnerStdin(input, bundle)) stream.write(part);
      stream.end();
      const status = this.api.wait(id);
      void Promise.all([ended, status]).then(
        () => queue.close(),
        () => queue.close(),
      );
      for await (const frame of queue.drain()) yield frame;
      const exitCode = await status;
      const state = await this.api.inspect(id).catch(() => undefined);
      if (state?.oomKilled) {
        outcome = 'SANDBOX_OOM';
        throw new SandboxError('SANDBOX_OOM', `The sandbox ran out of memory (${spec.memoryMb} MB).`);
      }
      if (stopReason === 'watchdog') {
        outcome = 'SANDBOX_TIMEOUT';
        throw new SandboxError(
          'SANDBOX_TIMEOUT',
          `The sandbox outlived its wall time (${spec.wallTimeSec} s) and was stopped.`,
        );
      }
      if (stopReason === 'aborted') {
        outcome = 'aborted';
        return;
      }
      if (!sawExit) {
        const tail = stderrTail.slice(-5).join(' | ');
        if (exitCode !== 0) {
          outcome = 'SANDBOX_CRASH';
          throw new SandboxError(
            'SANDBOX_CRASH',
            `The sandbox exited with ${exitCode} without finishing${tail ? `: ${tail}` : ''}.`,
          );
        }
        outcome = 'SANDBOX_PROTOCOL_ERROR';
        throw new SandboxError(
          'SANDBOX_PROTOCOL_ERROR',
          `The sandbox ended without an exit frame (${invalid} malformed frames).`,
        );
      }
      outcome = exitCode === 0 ? 'completed' : 'failed';
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      outcome = 'SANDBOX_CRASH';
      throw new SandboxError('SANDBOX_CRASH', `The sandbox failed: ${(error as Error).message}`);
    } finally {
      signal.removeEventListener('abort', onAbort);
      for (const timer of timers) clearTimeout(timer);
      await this.api.remove(id).catch(() => {});
      this.telemetry.finished(outcome, (performance.now() - started) / 1000);
    }
  }
}
