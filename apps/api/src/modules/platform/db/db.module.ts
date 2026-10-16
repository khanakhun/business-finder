import { closeDb, createDb, type DbClient } from '@bf/db';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../config/app-env.ts';
import { setTransactionalDb } from './transactional.ts';

export const DB_CLIENT = Symbol('DB_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: DB_CLIENT,
      inject: [APP_ENV],
      // postgres.js connects lazily on the first query: no I/O at import or boot (openapi mode never queries).
      useFactory: (env: AppEnv): DbClient => {
        const db = createDb({ url: env.DATABASE_URL, max: env.DB_POOL_MAX, applicationName: 'bf-api' });
        setTransactionalDb(db);
        return db;
      },
    },
  ],
  exports: [DB_CLIENT],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async onApplicationShutdown(): Promise<void> {
    await closeDb(this.db);
  }
}
