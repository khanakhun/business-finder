-- BF-058: SQL helpers for analytics ingestion (live and backfill share the same SQL).
-- A UUIDv7 for rows inserted in bulk (PostgreSQL 17 has no uuidv7()): the 48-bit Unix time in milliseconds over a
-- random v4 UUID, with the version bits set to 7.
CREATE OR REPLACE FUNCTION bf_uuid7() RETURNS uuid LANGUAGE sql VOLATILE AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
$$;--> statement-breakpoint
-- A business's dimensions as they are now (taken when its fact is ingested, i.e. at the event): its primary
-- category path, the smallest area that covers it (global areas or the workspace's own), its country, and the
-- workspace's tier and score.
CREATE OR REPLACE FUNCTION analytics_business_dims(org uuid, business uuid)
RETURNS TABLE (category_path ltree, area_id uuid, country text, score_tier text, score_value smallint)
LANGUAGE sql STABLE AS $$
  SELECT
    c.path,
    (
      SELECT a.id FROM geo_areas a
      WHERE b.location IS NOT NULL
        AND (a.organization_id IS NULL OR a.organization_id = org)
        AND ST_Covers(a.geom, b.location)
      ORDER BY ST_Area(a.geom) ASC
      LIMIT 1
    ),
    b.country_code,
    ob.tier,
    ob.score
  FROM businesses b
  LEFT JOIN categories c ON c.id = b.primary_category_id
  LEFT JOIN org_businesses ob ON ob.organization_id = org AND ob.business_id = b.id
  WHERE b.id = business;
$$;
