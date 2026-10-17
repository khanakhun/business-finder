import { request } from 'node:http';
import type { Duplex } from 'node:stream';

// A minimal Docker Engine API client (BF-043) over a unix socket or the socket proxy's TCP address: the few calls a
// sandbox run needs, and nothing else (the proxy allows only these). No SDK: the API is small and stable (v1.41+).

export const DOCKER_API_VERSION = 'v1.43';

export class DockerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DockerApiError';
  }
}

export interface ContainerState {
  readonly running: boolean;
  readonly exitCode: number;
  readonly oomKilled: boolean;
}

/** The calls the sandbox provider makes (a port: tests use a fake). */
export interface DockerApi {
  createContainer(name: string, config: Record<string, unknown>): Promise<string>;
  /** A hijacked attach stream: write stdin to it, read the multiplexed stdout/stderr from it. */
  attach(id: string): Promise<Duplex>;
  start(id: string): Promise<void>;
  wait(id: string): Promise<number>;
  kill(id: string, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  inspect(id: string): Promise<ContainerState>;
  remove(id: string): Promise<void>;
  imageExists(ref: string): Promise<boolean>;
  listContainers(
    labels: readonly string[],
  ): Promise<{ id: string; created: Date; labels: Record<string, string> }[]>;
}

/** `unix:///var/run/docker.sock` or `tcp://docker-socket-proxy:2375` / `http://…`. */
function target(host: string): { socketPath: string } | { hostname: string; port: number } {
  if (host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length) };
  const url = new URL(host.replace(/^tcp:/, 'http:'));
  return { hostname: url.hostname, port: Number(url.port || 2375) };
}

export class HttpDockerApi implements DockerApi {
  private readonly endpoint: ReturnType<typeof target>;

  constructor(host: string) {
    this.endpoint = target(host);
  }

  private call(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          ...this.endpoint,
          method,
          path: `/${DOCKER_API_VERSION}${path}`,
          headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
          );
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Docker API ${method} ${path} timed out`)));
      req.on('error', reject);
      req.end(payload);
    });
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
    ok: readonly number[] = [200, 201, 204],
    timeoutMs?: number,
  ): Promise<T> {
    const { status, text } = await this.call(method, path, body, timeoutMs);
    if (!ok.includes(status)) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {}
      throw new DockerApiError(status, `Docker API ${method} ${path}: ${status} ${message}`.slice(0, 500));
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async createContainer(name: string, config: Record<string, unknown>) {
    const created = await this.json<{ Id: string }>(
      'POST',
      `/containers/create?name=${encodeURIComponent(name)}`,
      config,
    );
    return created.Id;
  }

  attach(id: string): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const req = request({
        ...this.endpoint,
        method: 'POST',
        path: `/${DOCKER_API_VERSION}/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'tcp',
          'content-type': 'application/vnd.docker.raw-stream',
        },
      });
      req.on('upgrade', (_res, socket) => resolve(socket));
      req.on('response', (res) =>
        reject(new DockerApiError(res.statusCode ?? 0, `Docker attach refused: ${res.statusCode}`)),
      );
      req.on('error', reject);
      req.end();
    });
  }

  async start(id: string) {
    await this.json('POST', `/containers/${id}/start`, undefined, [204, 304]);
  }

  async wait(id: string) {
    const result = await this.json<{ StatusCode: number }>(
      'POST',
      `/containers/${id}/wait`,
      undefined,
      [200],
      6 * 3600_000,
    );
    return result.StatusCode;
  }

  async kill(id: string, signal: 'SIGTERM' | 'SIGKILL') {
    // 409: not running any more (it ended on its own).
    await this.json('POST', `/containers/${id}/kill?signal=${signal}`, undefined, [204, 404, 409]);
  }

  async inspect(id: string): Promise<ContainerState> {
    const info = await this.json<{ State: { Running: boolean; ExitCode: number; OOMKilled: boolean } }>(
      'GET',
      `/containers/${id}/json`,
    );
    return { running: info.State.Running, exitCode: info.State.ExitCode, oomKilled: info.State.OOMKilled };
  }

  async remove(id: string) {
    await this.json('DELETE', `/containers/${id}?force=1&v=1`, undefined, [204, 404, 409]);
  }

  async imageExists(ref: string) {
    const { status } = await this.call('GET', `/images/${encodeURIComponent(ref)}/json`);
    if (status === 200) return true;
    if (status === 404) return false;
    throw new DockerApiError(status, `Docker API image inspect: ${status}`);
  }

  async listContainers(labels: readonly string[]) {
    const filters = encodeURIComponent(JSON.stringify({ label: labels }));
    const rows = await this.json<{ Id: string; Created: number; Labels: Record<string, string> }[]>(
      'GET',
      `/containers/json?all=1&filters=${filters}`,
    );
    return rows.map((row) => ({
      id: row.Id,
      created: new Date(row.Created * 1000),
      labels: row.Labels ?? {},
    }));
  }
}

/**
 * Splits Docker's multiplexed attach stream (no TTY): 8-byte headers `[stream, 0, 0, 0, size(4, BE)]`, then the
 * payload; stream 1 is stdout, 2 is stderr.
 */
export function createDemuxer(onStdout: (chunk: Buffer) => void, onStderr: (chunk: Buffer) => void) {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 8) {
      const size = pending.readUInt32BE(4);
      if (pending.length < 8 + size) break;
      const payload = pending.subarray(8, 8 + size);
      if (pending[0] === 2) onStderr(payload);
      else onStdout(payload);
      pending = pending.subarray(8 + size);
    }
  };
}
