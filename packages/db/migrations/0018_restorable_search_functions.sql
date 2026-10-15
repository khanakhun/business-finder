-- Restorable backups (BF-025): pg_restore runs with an empty search_path, and generated columns call
-- bf_tsvector() while the data is loaded, so its body must name f_unaccent by schema. Same result as before.
CREATE OR REPLACE FUNCTION public.bf_tsvector(text_en text, text_fr text, text_simple text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT to_tsvector('english'::regconfig, public.f_unaccent(coalesce(text_en, '')))
        || to_tsvector('french'::regconfig, public.f_unaccent(coalesce(text_fr, '')))
        || to_tsvector('simple'::regconfig, public.f_unaccent(coalesce(text_simple, '')))
  $$;
