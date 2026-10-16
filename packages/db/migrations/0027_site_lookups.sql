CREATE INDEX "idx_site_publications__hostname" ON "site_publications" USING btree ("hostname");--> statement-breakpoint
-- The renderer's images, without computing the whole publications view per query (BF-035 review): the same meaning
-- (ready assets of sites that are not archived and have an active, unexpired publication), on the tables' indexes.
CREATE OR REPLACE VIEW renderer_site_assets WITH (security_barrier) AS
SELECT a.id, a.site_id, a.public_url, a.mime, a.width, a.height, a.variants, a.alt, a.focal_point, a.dominant_colors
FROM site_assets a
WHERE a.status = 'ready'
  AND EXISTS (
    SELECT FROM site_publications p
    JOIN sites s ON s.id = p.site_id
    WHERE p.site_id = a.site_id
      AND p.status = 'active'
      AND s.status <> 'archived'
      AND (p.expires_at IS NULL OR p.expires_at > now())
  );--> statement-breakpoint
-- Versions are deleted only with their site: a delete is allowed once the site row is gone (a site or workspace
-- cascade), not merely because it runs inside another trigger.
CREATE OR REPLACE FUNCTION site_versions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT FROM sites WHERE id = OLD.site_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'site_versions rows are deleted only with their site' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.quality IS NULL AND jsonb_typeof(NEW.quality) = 'object'
     AND (to_jsonb(NEW) - 'quality') = (to_jsonb(OLD) - 'quality') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'site_versions rows are immutable (only quality may be set, once)' USING ERRCODE = 'insufficient_privilege';
END;
$$;
