import type { ApiEnv } from '@bf/config';
import type { Logger } from '@bf/observability';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import { createValkey } from '../../platform/valkey/valkey.module.ts';
import { ORG_CHANNEL_PATTERN, type RealtimeMessage } from '../application/realtime-publisher.ts';

type Listener = (message: RealtimeMessage) => void;

/**
 * One Valkey subscription per API process (`PSUBSCRIBE rt:org:*`), fanned out to that process's SSE clients by
 * workspace — never one Valkey connection per browser tab.
 */
@Injectable()
export class RealtimeMultiplexer implements OnApplicationShutdown {
  private readonly listeners = new Map<string, Set<Listener>>();
  private connection: Redis | undefined;
  private ready: Promise<void> | undefined;

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Live messages for one workspace until the returned function is called. */
  async subscribe(orgId: string, listener: Listener): Promise<() => void> {
    await this.connect();
    const set = this.listeners.get(orgId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(orgId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(orgId);
    };
  }

  /** Workspaces with at least one connected client in this process. */
  get workspaceCount(): number {
    return this.listeners.size;
  }

  async onApplicationShutdown(): Promise<void> {
    this.listeners.clear();
    if (this.connection?.status === 'ready') await this.connection.quit();
    else this.connection?.disconnect();
  }

  private connect(): Promise<void> {
    this.ready ??= (async () => {
      const connection = createValkey((this.env as ApiEnv).VALKEY_URL, 'subscriber', this.logger);
      connection.on('pmessage', (_pattern: string, channel: string, raw: string) =>
        this.dispatch(channel, raw),
      );
      this.connection = connection;
      await connection.connect();
      await connection.psubscribe(ORG_CHANNEL_PATTERN);
    })().catch((error: unknown) => {
      // Let the next client try again.
      this.ready = undefined;
      this.connection?.disconnect();
      this.connection = undefined;
      throw error;
    });
    return this.ready;
  }

  private dispatch(channel: string, raw: string): void {
    const listeners = this.listeners.get(channel.slice('rt:org:'.length));
    if (!listeners?.size) return;
    let message: RealtimeMessage;
    try {
      message = JSON.parse(raw) as RealtimeMessage;
    } catch {
      this.logger.warn({ channel }, 'dropping malformed realtime message');
      return;
    }
    for (const listener of listeners) listener(message);
  }
}
