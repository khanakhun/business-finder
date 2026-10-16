import { closeDb, createDb, type DbClient, getExecutor } from '@bf/db';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bf/testing/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTransactionalDb, Transactional } from './transactional.ts';

let database: IsolatedDatabase;
let db: DbClient;

class NotesService {
  constructor(private readonly client: DbClient) {}

  @Transactional()
  async addTwo(first: string, second: string, failAfterFirst = false): Promise<void> {
    await this.insert(first);
    if (failAfterFirst) throw new Error('second step failed');
    await this.insert(second);
  }

  /** Stands in for a repository: knows only the root client, picks up the ambient transaction. */
  private async insert(text: string): Promise<void> {
    await getExecutor(this.client).execute(sql`INSERT INTO tx_probe (text) VALUES (${text})`);
  }
}

const count = async () =>
  (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM tx_probe`))[0]?.n;

beforeAll(async () => {
  database = await createIsolatedDatabase();
  db = createDb({ url: database.url, max: 2 });
  await db.execute(sql`CREATE TABLE tx_probe (text text NOT NULL)`);
});

afterAll(async () => {
  setTransactionalDb(undefined);
  await closeDb(db);
  await database.drop();
});

describe('@Transactional()', () => {
  it('fails clearly before DbModule has initialised', async () => {
    setTransactionalDb(undefined);
    await expect(new NotesService(db).addTwo('a', 'b')).rejects.toThrow(/before DbModule initialised/);
  });

  it('commits every step together', async () => {
    setTransactionalDb(db);
    await new NotesService(db).addTwo('one', 'two');
    expect(await count()).toBe(2);
  });

  it('rolls back earlier steps when a later one fails', async () => {
    setTransactionalDb(db);
    await expect(new NotesService(db).addTwo('three', 'four', true)).rejects.toThrow('second step failed');
    expect(await count()).toBe(2);
  });
});
