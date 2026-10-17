-- BF-062: what a live site's legal notice and privacy pages show — the business's legal profile and the agency as
-- host — readable by the renderer's read-only role for sites with an active live publication only.
CREATE VIEW renderer_site_legal WITH (security_barrier) AS
SELECT
  l.site_id,
  l.business_legal_name,
  l.legal_form,
  l.registration,
  l.vat_number,
  l.address,
  l.phone,
  l.email::text AS email,
  l.publication_director,
  l.dpo_contact,
  coalesce(nullif(btrim(os.legal_name), ''), nullif(btrim(os.agency_name), ''), o.name) AS host_name,
  CASE
    WHEN os.postal_address IS NULL THEN NULL
    ELSE concat_ws(', ', os.postal_address ->> 'line1', os.postal_address ->> 'line2',
      concat_ws(' ', os.postal_address ->> 'postalCode', os.postal_address ->> 'city'),
      os.postal_address ->> 'countryCode')
  END AS host_address,
  CASE WHEN os.website_url ~* '^https?://[^\s"<>]+$' THEN os.website_url END AS host_url,
  l.version,
  l.updated_at
FROM site_legal_profiles l
JOIN sites s ON s.id = l.site_id
JOIN organizations o ON o.id = s.organization_id
LEFT JOIN org_settings os ON os.organization_id = s.organization_id
WHERE EXISTS (
  SELECT 1 FROM site_publications p
  WHERE p.site_id = l.site_id AND p.environment = 'live' AND p.status = 'active'
);--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'bf_sites_ro') THEN
    GRANT SELECT ON renderer_site_legal TO bf_sites_ro;
  END IF;
END
$$;
