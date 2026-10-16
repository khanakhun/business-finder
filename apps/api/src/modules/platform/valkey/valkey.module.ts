import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_ENV, type AppEnv } from '../config/app-env.ts';
import { LOGGER, type Logger } from '../logging/logger.ts';

export const VALKEY = Symbol('VALKEY');

export type ValkeyRole = 'shared' | 'blocking';

/** Upper bound for one command on the shared connection (normal round-trips take about a millisecond). */
const SHARED_COMMAND_TIMEOUT_MS = 500;

/**
 * Valkey connection. `shared` (HTTP path, throttler, producers) fails fast when Valkey is down so requests never
 * hang; `blocking` (BullMQ workers) retries forever, as BullMQ requires. Both connect lazily: no I/O at import.
 */
export function createValkey(url: string, role: ValkeyRole, logger?: Logger): Redis {
  const valkey = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: role === 'blocking' ? null : 1,
    // Commands also wait in the offline queue while ioredis reconnects; bound that wait on the request path.
    ...(role === 'shared' ? { commandTimeout: SHARED_COMMAND_TIMEOUT_MS } : {}),
    enableReadyCheck: true,
  });
  let lastError = '';
  valkey.on('error', (error: Error) => {
    // ioredis emits on every reconnect attempt; log each distinct failure once.
    if (error.message === lastError) return;
    lastError = error.message;
    logger?.warn({ err: error, role }, 'valkey connection error');
  });
  valkey.on('ready', () => {
    lastError = '';
  });
  return valkey;
}

@Global()
@Module({
  providers: [
    {
      provide: VALKEY,
      inject: [APP_ENV, LOGGER],
      useFactory: (env: AppEnv, logger: Logger) => createValkey(env.VALKEY_URL, 'shared', logger),
    },
  ],
  exports: [VALKEY],
})
export class ValkeyModule implements OnApplicationShutdown {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.valkey.status === 'ready') await this.valkey.quit();
    else this.valkey.disconnect();
  }
}
