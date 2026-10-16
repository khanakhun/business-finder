import { closeDb, createDb, type DbClient } from '@bf/db';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../config/app-env.ts';
import { setTransactionalDb } from './transactional.ts';

export const DB_CLIENT = Symbol('DB_CLIENT');

/**
 * The client this application created (and so closes on shutdown). A client provided from outside — a test worker
 * sharing its app's client — belongs to its owner.
 */
const DB_OWNERSHIP = Symbol('DB_OWNERSHIP');
interface DbOwnership {
  created?: DbClient;
}

@Global()
@Module({
  providers: [
    { provide: DB_OWNERSHIP, useFactory: (): DbOwnership => ({}) },
    {
      provide: DB_CLIENT,
      inject: [APP_ENV, DB_OWNERSHIP],
      // postgres.js connects lazily on the first query: no I/O at import or boot (openapi mode never queries).
      useFactory: (env: AppEnv, ownership: DbOwnership): DbClient => {
        const db = createDb({ url: env.DATABASE_URL, max: env.DB_POOL_MAX, applicationName: 'bf-api' });
        ownership.created = db;
        setTransactionalDb(db);
        return db;
      },
    },
  ],
  exports: [DB_CLIENT],
})
export class DbModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(DB_OWNERSHIP) private readonly ownership: DbOwnership,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.ownership.created === this.db) await closeDb(this.db);
  }
}
