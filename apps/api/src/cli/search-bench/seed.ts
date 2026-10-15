import { type DbClient, type DbTransaction, runInTransaction } from '@bf/db';
import { sql } from 'drizzle-orm';

// Synthetic listing data for the search benchmark and EXPLAIN tests (BF-022): N fake businesses tracked by one
// workspace, generated inside Postgres (generate_series) so 200k rows take seconds. Deterministic: row i always
// gets the same values. Names, places and contacts are invented (".example" domains, +590 690 0… numbers).

export interface SearchBenchOptions {
  readonly organizationId: string;
  readonly businesses: number;
  /** How many of them get an embedding (fake deterministic vectors of `embeddingModel`). */
  readonly embedded: number;
  readonly embeddingModel: string;
}

const PREFIXES = [
  'Boulangerie',
  'Café',
  'Salon',
  'Atelier',
  'Villa',
  'Chez',
  'Le Petit',
  'La Maison',
  'Studio',
  'Spa',
];
const WORDS = [
  'du Port',
  'des Arts',
  'Belle Vue',
  'Soleil',
  'Corail',
  'Lagon',
  'Alizé',
  'Caraïbes',
  'Flamboyant',
  'Hibiscus',
  'Baie',
  'Plage',
  'Colibri',
  'Mangue',
  'Coco',
  'Vanille',
  'Océan',
  'Récif',
  'Palmier',
  'Tortue',
];
const LOCALITIES = [
  'Gustavia',
  'Saint-Jean',
  'Lorient',
  'Flamands',
  'Corossol',
  'Marigot',
  'Grand Case',
  'Philipsburg',
  'Basse-Terre',
  'Pointe-à-Pitre',
  'Fort-de-France',
  'Le Gosier',
  'Sainte-Anne',
  'Deshaies',
  'Bouillante',
  'Le Moule',
  'Saint-François',
  'Capesterre',
  'Trois-Rivières',
  'Les Saintes',
];

const textArray = (values: readonly string[]) =>
  sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

/** Inserts the data and ANALYZEs; returns how long it took (ms). */
export async function seedSearchBench(db: DbClient, options: SearchBenchOptions): Promise<number> {
  const started = performance.now();
  // One transaction without the app's statement timeout: the category-text trigger refreshes every row at once.
  await runInTransaction(db, async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = 0`);
    await seed(tx, options);
  });
  return performance.now() - started;
}

async function seed(db: DbTransaction, options: SearchBenchOptions): Promise<void> {
  const n = options.businesses;
  await db.execute(sql`
    INSERT INTO businesses (id, display_name, normalized_name, primary_category_id, operating_status, website_url,
      website_host, primary_phone_e164, country_code, location, locality, formatted_address, postal_code, price_level,
      rating_avg, rating_count)
    SELECT
      (lpad(to_hex(1760000000000 + i), 12, '0') || '7' || substr(md5(i::text), 1, 3) || '8' || substr(md5(i::text), 4, 15))::uuid,
      name, lower(f_unaccent(name)),
      cat.id,
      CASE WHEN i % 50 = 0 THEN 'closed_permanently' ELSE 'operational' END,
      CASE WHEN i % 10 < 7 THEN 'https://www.bench-' || i || '.example/' END,
      CASE WHEN i % 10 < 7 THEN 'www.bench-' || i || '.example' END,
      CASE WHEN i % 5 <> 0 THEN '+590690' || lpad((i % 1000000)::text, 6, '0') END,
      CASE WHEN i % 3 = 0 THEN 'FR' ELSE 'BL' END,
      -- Half on a ~100 km region, half clustered around Gustavia.
      CASE WHEN i % 2 = 0
        THEN ST_SetSRID(ST_MakePoint(-62.85 + ((i::bigint * 7919) % 1000) / 20000.0, 17.9 + ((i::bigint * 104729) % 1000) / 20000.0), 4326)::geography
        ELSE ST_SetSRID(ST_MakePoint(-62.0 + ((i::bigint * 7919) % 1000) / 1000.0, 16.0 + ((i::bigint * 104729) % 1000) / 1000.0), 4326)::geography
      END,
      (${textArray(LOCALITIES)})[1 + i % ${LOCALITIES.length}],
      (i % 99 + 1) || ' Rue ' || (${textArray(WORDS)})[1 + (i / 7) % ${WORDS.length}],
      '97133',
      CASE WHEN i % 4 = 0 THEN NULL ELSE (i % 4) END,
      CASE WHEN i % 7 = 0 THEN NULL ELSE round((2 + (i % 31) / 10.0)::numeric, 1) END,
      CASE WHEN i % 7 = 0 THEN NULL ELSE i % 500 END
    FROM generate_series(1, ${n}) AS i
    CROSS JOIN LATERAL (
      SELECT (${textArray(PREFIXES)})[1 + i % ${PREFIXES.length}] || ' ' ||
        (${textArray(WORDS)})[1 + (i / ${PREFIXES.length}) % ${WORDS.length}] || ' ' || i AS name
    ) AS named
    CROSS JOIN LATERAL (
      SELECT id FROM categories WHERE nlevel(path) >= 2 ORDER BY slug OFFSET (i % 120) LIMIT 1
    ) AS cat`);
  await db.execute(sql`
    INSERT INTO business_categories (business_id, category_id, is_primary, confidence, source)
    SELECT id, primary_category_id, true, 1, 'bench' FROM businesses WHERE primary_category_id IS NOT NULL
    ON CONFLICT DO NOTHING`);
  await db.execute(sql`
    INSERT INTO business_contacts (id, business_id, type, value, normalized_value, source, confidence, verification_status)
    SELECT
      (lpad(to_hex(1770000000000 + row_number() OVER ()), 12, '0') || '7' || substr(md5(b.id::text), 1, 3) || '8' || substr(md5(b.id::text), 4, 15))::uuid,
      b.id, 'email', 'hello@' || b.website_host, 'hello@' || b.website_host, 'website', 0.9,
      CASE WHEN get_byte(decode(md5(b.id::text), 'hex'), 0) % 2 = 0 THEN 'valid' ELSE 'unknown' END
    FROM businesses b WHERE b.website_host IS NOT NULL AND get_byte(decode(md5(b.id::text), 'hex'), 1) % 2 = 0`);
  await db.execute(sql`
    INSERT INTO org_businesses (organization_id, business_id, pipeline_status, added_via, score, tier, tags, created_at)
    SELECT ${options.organizationId}, b.id,
      (ARRAY['new','qualified','disqualified','contacted','engaged','meeting','proposal','won','lost'])[1 + k % 9],
      'discovery',
      CASE WHEN k % 5 = 0 THEN NULL ELSE k % 101 END,
      CASE WHEN k % 5 = 0 THEN NULL ELSE (ARRAY['A','B','C','X'])[1 + k % 4] END,
      CASE WHEN k % 7 = 0 THEN ARRAY['vip']::text[] WHEN k % 11 = 0 THEN ARRAY['follow-up']::text[] ELSE '{}'::text[] END,
      now() - make_interval(secs => k)
    FROM (SELECT id, row_number() OVER (ORDER BY id) AS k FROM businesses) b`);
  await db.execute(sql`
    UPDATE businesses b SET
      embedding = (SELECT array_agg(sin(e.k * 0.37 + d * 1.13 + e.k % 97) ORDER BY d)::vector(1536) FROM generate_series(1, 1536) d),
      embedding_model = ${options.embeddingModel}
    FROM (SELECT id, row_number() OVER (ORDER BY id) AS k FROM businesses) e
    WHERE e.id = b.id AND e.k <= ${options.embedded}`);
  for (const table of ['businesses', 'org_businesses', 'business_categories', 'business_contacts']) {
    await db.execute(sql.raw(`ANALYZE ${table}`));
  }
}
