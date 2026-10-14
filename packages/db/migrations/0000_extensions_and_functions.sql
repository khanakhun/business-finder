-- BF-003: extensions and shared SQL functions every bounded context builds on. Hand-written (drizzle-kit --custom).
-- Idempotent: safe on databases where the image's init already enabled postgis.
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS ltree;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint

-- unaccent() is only STABLE (its dictionary could change), so it cannot be used in generated columns or index
-- expressions. Pinning the dictionary makes this wrapper safely IMMUTABLE.
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;
--> statement-breakpoint

-- Keeps updated_at current. Attach per table:
--   CREATE TRIGGER trg_<table>__updated_at BEFORE UPDATE ON <table>
--     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Bilingual (EN/FR) full-text document, accent-insensitive: English and French stemming plus a `simple`
-- (unstemmed) pass for names and brands. Callers apply setweight() as they need.
CREATE OR REPLACE FUNCTION bf_tsvector(text_en text, text_fr text, text_simple text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT to_tsvector('english'::regconfig, f_unaccent(coalesce(text_en, '')))
        || to_tsvector('french'::regconfig, f_unaccent(coalesce(text_fr, '')))
        || to_tsvector('simple'::regconfig, f_unaccent(coalesce(text_simple, '')))
  $$;
--> statement-breakpoint

-- apps/sites' read-only role (infra/docker/postgres/init) needs schema usage; re-granted here because
-- `db:reset` recreates the schema. Table grants are added by the migrations that create those tables (BF-035).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'bf_sites_ro') THEN
    GRANT USAGE ON SCHEMA public TO bf_sites_ro;
  END IF;
END
$$;
