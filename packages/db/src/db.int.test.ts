import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedDatabase, type IsolatedDatabase, truncateAll } from '@bf/testing/db';
import { asc, eq, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, type DbClient } from './client.ts';
import { id, timestamps } from './columns.ts';
import { MIGRATIONS_DIR, runMigrations } from './migrate.ts';
import { runSeeds, type SeedModule } from './seed/runner.ts';
import { withRollback } from './testing.ts';
import { getExecutor, isInTransaction, NestedIsolationLevelError, runInTransaction } from './tx.ts';
import { geographyMultiPolygon, geographyPoint } from './types/geography.ts';
import { citext, ltree, tsvector } from './types/text.ts';
import { vector } from './types/vector.ts';

// Throwaway table exercising every custom type (BF-003 adds no domain tables).
const places = pgTable('places', {
  id: id(),
  name: text().notNull(),
  location: geographyPoint(),
  area: geographyMultiPolygon(),
  embedding: vector(3),
  category: ltree(),
  email: citext(),
  search: tsvector(),
  ...timestamps(),
});

const CREATE_PLACES = `
  CREATE TABLE places (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    location geography(Point,4326),
    area geography(MultiPolygon,4326),
    embedding vector(3),
    category ltree,
    email citext,
    search tsvector GENERATED ALWAYS AS (bf_tsvector(name, name, name)) STORED,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TRIGGER trg_places__updated_at BEFORE UPDATE ON places FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`;

// Gustavia and Saint-Jean (Saint-Barthélemy), ~2.3 km apart; Paris far away.
const GUSTAVIA = { lat: 17.8962, lng: -62.8498 };
const SAINT_JEAN = { lat: 17.9029, lng: -62.8297 };
const PARIS = { lat: 48.8566, lng: 2.3522 };
const ISLAND = {
  type: 'MultiPolygon' as const,
  coordinates: [
    [
      [
        [-62.88, 17.87],
        [-62.79, 17.87],
        [-62.79, 17.93],
        [-62.88, 17.93],
        [-62.88, 17.87],
      ] as [number, number][],
    ],
  ],
};

/** Drizzle wraps driver errors ("Failed query: …"); the Postgres message is on `cause`. */
async function causeOf(promise: PromiseLike<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
  }
  throw new Error('expected the query to fail');
}

let database: IsolatedDatabase;
let db: DbClient;

beforeAll(async () => {
  const started = performance.now();
  database = await createIsolatedDatabase();
  expect(performance.now() - started, 'isolated database creation must stay fast').toBeLessThan(3_000);
  db = createDb({ url: database.url, max: 4, applicationName: 'bf-int-test' });
  await db.execute(sql.raw(CREATE_PLACES));
});

afterAll(async () => {
  await closeDb(db);
  await database.drop();
});

describe('migration 0000', () => {
  it('installs every extension', async () => {
    const rows = await db.execute<{ extname: string }>(
      sql`SELECT extname FROM pg_extension ORDER BY extname`,
    );
    expect(rows.map((r) => r.extname)).toEqual(
      expect.arrayContaining(['citext', 'ltree', 'pg_trgm', 'pgcrypto', 'postgis', 'unaccent', 'vector']),
    );
  });

  it('creates the shared functions', async () => {
    const rows = await db.execute<{ proname: string }>(
      sql`SELECT proname FROM pg_proc WHERE proname IN ('f_unaccent', 'set_updated_at', 'bf_tsvector') ORDER BY proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['bf_tsvector', 'f_unaccent', 'set_updated_at']);
  });

  it('is a no-op when re-run', async () => {
    await expect(runMigrations(database.url)).resolves.toBeUndefined();
    const [row] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    // Every journal entry applied exactly once, nothing more.
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
      entries: unknown[];
    };
    expect(row?.n).toBe(journal.entries.length);
  });
});

describe('custom types', () => {
  it('round-trip through insert and select', async () => {
    const [inserted] = await db
      .insert(places)
      .values({
        name: 'Café du Port',
        location: GUSTAVIA,
        area: ISLAND,
        embedding: [0.1, 0.2, 0.3],
        category: 'food.restaurant.cafe',
        email: 'Hello@Example.TEST',
      })
      .returning();
    expect(inserted).toMatchObject({
      location: GUSTAVIA,
      area: ISLAND,
      embedding: [0.1, 0.2, 0.3],
      category: 'food.restaurant.cafe',
      email: 'Hello@Example.TEST',
    });
    expect(inserted?.search).toContain("'cafe'");
    const [reread] = await db
      .select()
      .from(places)
      .where(eq(places.id, inserted?.id ?? ''));
    expect(reread).toEqual(inserted);
  });

  it('stores points with longitude as X (lat/lng not swapped)', async () => {
    const [row] = await db
      .insert(places)
      .values({ name: 'Orientation check', location: GUSTAVIA })
      .returning({ id: places.id });
    const [xy] = await db.execute<{ x: number; y: number }>(
      sql`SELECT ST_X(location::geometry) AS x, ST_Y(location::geometry) AS y FROM places WHERE id = ${row?.id}`,
    );
    expect(xy).toEqual({ x: GUSTAVIA.lng, y: GUSTAVIA.lat });
  });

  it('compares citext case-insensitively', async () => {
    const rows = await db
      .select({ name: places.name })
      .from(places)
      .where(eq(places.email, 'hello@example.test'));
    expect(rows).toEqual([{ name: 'Café du Port' }]);
  });
});

describe('queries the platform relies on', () => {
  beforeAll(async () => {
    await db.insert(places).values([
      {
        name: 'Le Saint-Jean',
        location: SAINT_JEAN,
        embedding: [0.1, 0.2, 0.35],
        category: 'food.restaurant',
      },
      { name: 'Paris bakery', location: PARIS, embedding: [0.9, -0.5, 0.1], category: 'food.bakery' },
      { name: 'Island Spa', location: GUSTAVIA, embedding: [-0.3, 0.8, 0.2], category: 'wellness.spa' },
    ]);
  });

  it('finds places within a radius (ST_DWithin, metres)', async () => {
    const rows = await db
      .select({ name: places.name })
      .from(places)
      .where(
        sql`ST_DWithin(${places.location}, ST_SetSRID(ST_MakePoint(${GUSTAVIA.lng}, ${GUSTAVIA.lat}), 4326)::geography, 3000)`,
      )
      .orderBy(asc(places.name));
    expect(rows.map((r) => r.name)).toEqual([
      'Café du Port',
      'Island Spa',
      'Le Saint-Jean',
      'Orientation check',
    ]);
  });

  it('finds places inside an area polygon', async () => {
    const rows = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM places p, places a WHERE a.area IS NOT NULL AND ST_Covers(a.area, p.location)`,
    );
    expect(rows[0]?.n).toBe(4);
  });

  it('orders by cosine distance (pgvector <=>)', async () => {
    const rows = await db
      .select({ name: places.name })
      .from(places)
      .where(sql`${places.embedding} IS NOT NULL`)
      .orderBy(sql`${places.embedding} <=> ${'[0.1,0.2,0.3]'}::vector`);
    expect(rows.map((r) => r.name)).toEqual(['Café du Port', 'Le Saint-Jean', 'Island Spa', 'Paris bakery']);
  });

  it('queries ltree descendants', async () => {
    const rows = await db
      .select({ name: places.name })
      .from(places)
      .where(sql`${places.category} <@ 'food.restaurant'`)
      .orderBy(asc(places.name));
    expect(rows.map((r) => r.name)).toEqual(['Café du Port', 'Le Saint-Jean']);
  });

  it('matches full-text search accent-insensitively (Café ↔ cafe)', async () => {
    const rows = await db
      .select({ name: places.name })
      .from(places)
      .where(sql`${places.search} @@ plainto_tsquery('simple', f_unaccent(${'cafe'}))`);
    expect(rows).toEqual([{ name: 'Café du Port' }]);
  });

  it('maintains updated_at with the set_updated_at trigger', async () => {
    const [before] = await db.select().from(places).where(eq(places.name, 'Island Spa'));
    await db.execute(sql`SELECT pg_sleep(0.01)`);
    const [after] = await db
      .update(places)
      .set({ category: 'wellness.spa.day' })
      .where(eq(places.name, 'Island Spa'))
      .returning();
    expect(after?.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);
    expect(after?.createdAt).toEqual(before?.createdAt);
  });
});

describe('transaction context', () => {
  const count = async (name: string) =>
    (await db.select({ id: places.id }).from(places).where(eq(places.name, name))).length;

  it('gives repositories the ambient transaction through getExecutor', async () => {
    expect(getExecutor(db)).toBe(db);
    await runInTransaction(db, async (tx) => {
      expect(isInTransaction(db)).toBe(true);
      expect(getExecutor(db)).toBe(tx);
      // A "repository" that only knows `db`:
      await getExecutor(db).insert(places).values({ name: 'tx-commit' });
    });
    expect(isInTransaction(db)).toBe(false);
    expect(await count('tx-commit')).toBe(1);
  });

  it('rolls back everything when a nested call fails', async () => {
    await expect(
      runInTransaction(db, async () => {
        await getExecutor(db).insert(places).values({ name: 'tx-outer' });
        await runInTransaction(db, async (inner) => {
          expect(inner).toBe(getExecutor(db));
          await getExecutor(db).insert(places).values({ name: 'tx-inner' });
          throw new Error('inner failure');
        });
      }),
    ).rejects.toThrow('inner failure');
    expect(await count('tx-outer')).toBe(0);
    expect(await count('tx-inner')).toBe(0);
  });

  it('keeps outer work when a savepoint fails and is caught', async () => {
    await runInTransaction(db, async () => {
      await getExecutor(db).insert(places).values({ name: 'sp-outer' });
      await runInTransaction(
        db,
        async () => {
          await getExecutor(db).insert(places).values({ name: 'sp-inner' });
          throw new Error('savepoint failure');
        },
        { savepoint: true },
      ).catch(() => undefined);
    });
    expect(await count('sp-outer')).toBe(1);
    expect(await count('sp-inner')).toBe(0);
  });

  it('refuses to change the isolation level of a running transaction', async () => {
    await expect(
      runInTransaction(db, () => runInTransaction(db, async () => 1, { isolationLevel: 'serializable' })),
    ).rejects.toThrow(NestedIsolationLevelError);
  });

  it('applies the requested isolation level', async () => {
    const level = await runInTransaction(
      db,
      async (tx) =>
        (
          await tx.execute<{ level: string }>(sql`SELECT current_setting('transaction_isolation') AS level`)
        )[0]?.level,
      { isolationLevel: 'serializable' },
    );
    expect(level).toBe('serializable');
  });

  it('isolates concurrent transactions from each other', async () => {
    let releaseA: () => void = () => undefined;
    const aInserted = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let finishA: () => void = () => undefined;
    const aMayFinish = new Promise<void>((resolve) => {
      finishA = resolve;
    });

    const a = runInTransaction(db, async () => {
      await getExecutor(db).insert(places).values({ name: 'concurrent-a' });
      releaseA();
      await aMayFinish;
    });
    const b = runInTransaction(db, async (tx) => {
      await aInserted;
      expect(getExecutor(db)).toBe(tx);
      const seen = await getExecutor(db).select().from(places).where(eq(places.name, 'concurrent-a'));
      finishA();
      return seen.length;
    });
    const [, seenByB] = await Promise.all([a, b]);
    expect(seenByB).toBe(0);
    expect(await count('concurrent-a')).toBe(1);
  });

  it('withRollback discards everything, even work done through getExecutor', async () => {
    const result = await withRollback(db, async () => {
      await getExecutor(db).insert(places).values({ name: 'rolled-back' });
      return count('rolled-back');
    });
    expect(result).toBe(0); // `count` uses the root client, outside the transaction
    expect(await count('rolled-back')).toBe(0);
  });

  it('withRollback propagates errors from the callback', async () => {
    await expect(withRollback(db, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});

describe('createDb', () => {
  it('sets application name and statement timeout on every connection', async () => {
    const tuned = createDb({
      url: database.url,
      max: 1,
      applicationName: 'bf-check',
      statementTimeoutMs: 1234,
    });
    try {
      const [row] = await tuned.execute<{ app: string; timeout: string }>(
        sql`SELECT current_setting('application_name') AS app, current_setting('statement_timeout') AS timeout`,
      );
      expect(row).toEqual({ app: 'bf-check', timeout: '1234ms' });
      expect(await causeOf(tuned.execute(sql`SELECT pg_sleep(2)`))).toMatch(/statement timeout/);
    } finally {
      await closeDb(tuned);
    }
  });

  it('rejects writes on a read-only client', async () => {
    const readOnly = createDb({ url: database.url, max: 1, readOnly: true });
    try {
      expect(await causeOf(readOnly.insert(places).values({ name: 'nope' }))).toMatch(
        /read-only transaction/,
      );
    } finally {
      await closeDb(readOnly);
    }
  });
});

describe('seed runner', () => {
  const insertOnce =
    (name: string): SeedModule['run'] =>
    async (client) => {
      await client.execute(sql`
        INSERT INTO places (id, name) SELECT gen_random_uuid(), ${name}
        WHERE NOT EXISTS (SELECT 1 FROM places WHERE name = ${name})`);
    };
  const modules: SeedModule[] = [
    { name: 'base', environments: ['dev', 'test', 'staging'], run: insertOnce('seed-base') },
    { name: 'demo', environments: ['dev'], run: insertOnce('seed-demo') },
  ];

  it('runs modules for the environment, in order, idempotently', async () => {
    expect(await runSeeds(db, modules, { environment: 'dev' })).toEqual(['base', 'demo']);
    expect(await runSeeds(db, modules, { environment: 'dev' })).toEqual(['base', 'demo']);
    expect(await runSeeds(db, modules, { environment: 'staging' })).toEqual(['base']);
    const rows = await db.select({ name: places.name }).from(places).where(sql`${places.name} LIKE 'seed-%'`);
    expect(rows.map((r) => r.name).sort()).toEqual(['seed-base', 'seed-demo']);
  });

  it('runs only the requested modules', async () => {
    const log: string[] = [];
    expect(
      await runSeeds(db, modules, { environment: 'dev', only: ['demo'], log: (l) => log.push(l) }),
    ).toEqual(['demo']);
    expect(log).toEqual(['seed demo …']);
  });

  it('rejects unknown and duplicate module names', async () => {
    await expect(runSeeds(db, modules, { environment: 'dev', only: ['nope'] })).rejects.toThrow(
      /Unknown seed module/,
    );
    await expect(
      runSeeds(db, [...modules, modules[0] as SeedModule], { environment: 'dev' }),
    ).rejects.toThrow(/unique/);
  });

  it('rolls back a failing module', async () => {
    const failing: SeedModule = {
      name: 'broken',
      environments: ['dev'],
      async run(client) {
        await client.execute(sql`INSERT INTO places (id, name) VALUES (gen_random_uuid(), 'seed-broken')`);
        throw new Error('seed failed');
      },
    };
    await expect(runSeeds(db, [failing], { environment: 'dev' })).rejects.toThrow('seed failed');
    expect(await db.select().from(places).where(eq(places.name, 'seed-broken'))).toEqual([]);
  });
});

describe('truncateAll', () => {
  it('empties application tables but keeps PostGIS reference data', async () => {
    await truncateAll(database.url);
    expect(await db.select().from(places)).toEqual([]);
    const [srs] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM spatial_ref_sys`);
    expect(srs?.n).toBeGreaterThan(1000);
  });

  it('empties append-only tables and puts their guard back exactly as it was', async () => {
    await db.execute(
      sql`INSERT INTO audit_logs (id, actor_type, action) VALUES (gen_random_uuid(), 'system', 'test.ran')`,
    );
    await truncateAll(database.url);
    const [rows] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_logs`);
    expect(rows?.n).toBe(0);
    const modes = await db.execute<{ mode: string }>(
      sql`SELECT tgenabled AS mode FROM pg_trigger WHERE tgname LIKE 'audit_logs_no_%' ORDER BY tgname`,
    );
    expect(modes.map((row) => row.mode)).toEqual(['A', 'A']);
    await expect(db.execute(sql`TRUNCATE audit_logs`)).rejects.toThrow();
  });
});
