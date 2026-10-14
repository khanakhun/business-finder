/** Connection details of the shared test Postgres, passed from global setup to test workers. */
export interface TestPostgres {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** Fully migrated database that isolated test databases are cloned from. */
  readonly template: string;
}

export const PROVIDE_KEY = 'bfTestPostgres';

declare module 'vitest' {
  export interface ProvidedContext {
    bfTestPostgres: TestPostgres;
  }
}

export function databaseUrl(pg: TestPostgres, database: string): string {
  const auth = `${encodeURIComponent(pg.user)}:${encodeURIComponent(pg.password)}`;
  return `postgres://${auth}@${pg.host}:${pg.port}/${encodeURIComponent(database)}`;
}
