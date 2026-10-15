import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';

export interface ReceivedSse {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
  readonly comment?: string;
}

/** Starts listening on a random port (SSE needs a real streaming connection, not supertest). */
export async function baseUrlOf(app: INestApplication): Promise<string> {
  const server = app.getHttpServer();
  if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Session cookie for a verified user (signs in over HTTP with a browser-like Origin and client IP). */
export async function sessionCookie(
  baseUrl: string,
  origin: string,
  email: string,
  password: string,
  ip: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status}`);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

/** An open SSE connection that records what it receives. */
export interface SseConnection {
  readonly status: number;
  readonly messages: ReceivedSse[];
  /** Resolves once the server says live delivery is set up (`: ready`). */
  ready(timeoutMs?: number): Promise<void>;
  /** Resolves when `count` messages with `event` arrived. */
  waitFor(event: string, count?: number, timeoutMs?: number): Promise<ReceivedSse[]>;
  close(): void;
}

export async function openSse(url: string, headers: Record<string, string>): Promise<SseConnection> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...headers },
    signal: controller.signal,
  });
  const messages: ReceivedSse[] = [];
  if (response.ok && response.body) {
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    void (async () => {
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += value;
          let end = buffer.indexOf('\n\n');
          while (end >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const message: Record<string, string> = {};
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) message.comment = line.slice(1).trim();
              else {
                const colon = line.indexOf(':');
                message[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
              }
            }
            messages.push(message);
            end = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // Aborted by close().
      }
    })();
  }
  return {
    status: response.status,
    messages,
    async ready(timeoutMs = 5_000) {
      const started = Date.now();
      while (!messages.some((m) => m.comment === 'ready')) {
        if (Date.now() - started > timeoutMs) throw new Error('stream never became ready');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async waitFor(event, count = 1, timeoutMs = 5_000) {
      const started = Date.now();
      for (;;) {
        const matching = messages.filter((m) => m.event === event);
        if (matching.length >= count) return matching;
        if (Date.now() - started > timeoutMs) {
          throw new Error(`timed out waiting for ${count} × ${event}; got ${JSON.stringify(messages)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    close: () => controller.abort(),
  };
}
