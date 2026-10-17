CREATE TABLE "site_domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"hostname" "citext" NOT NULL,
	"kind" text NOT NULL,
	"redirect_to" "citext",
	"verification_token" text NOT NULL,
	"status" text DEFAULT 'pending_dns' NOT NULL,
	"dns_report" jsonb,
	"tls_status" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_domains" ADD CONSTRAINT "site_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_domains" ADD CONSTRAINT "site_domains_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_domains" ADD CONSTRAINT "site_domains_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_site_domains__hostname" ON "site_domains" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "ix_site_domains__site" ON "site_domains" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "ix_site_domains__due" ON "site_domains" USING btree ("status","next_check_at");--> statement-breakpoint
-- BF-062: the renderer view gains the redirect of a hostname (custom domains).
CREATE OR REPLACE VIEW renderer_published_sites WITH (security_barrier) AS
SELECT
  latest.hostname,
  latest.site_id,
  latest.status,
  b.display_name AS business_name,
  coalesce(nullif(btrim(os.agency_name), ''), o.name) AS agency_name,
  CASE WHEN os.website_url ~* '^https?://[^\s"<>]+$' THEN os.website_url END AS agency_url,
  latest.environment,
  latest.version_id,
  CASE WHEN latest.status = 'active' THEN v.spec END AS spec,
  latest.expires_at,
  (latest.environment = 'preview') AS noindex,
  (latest.environment = 'preview') AS preview_banner,
  -- BF-062: where this hostname redirects (301): a `www` name to its apex; the site's own hostname, once live, to
  -- its active custom domain.
  coalesce(
    (SELECT d.redirect_to::text FROM site_domains d
      WHERE d.hostname = latest.hostname AND d.status = 'active' AND d.redirect_to IS NOT NULL),
    CASE WHEN latest.environment = 'live' AND NOT EXISTS (SELECT 1 FROM site_domains d2 WHERE d2.hostname = latest.hostname)
      THEN (SELECT d3.hostname::text FROM site_domains d3
        WHERE d3.site_id = latest.site_id AND d3.status = 'active' AND d3.redirect_to IS NULL
        ORDER BY d3.created_at LIMIT 1)
    END
  ) AS redirect_to
FROM (
  SELECT DISTINCT ON (p.hostname)
    p.hostname,
    p.site_id,
    p.environment,
    p.version_id,
    p.expires_at,
    CASE
      WHEN s.status = 'archived' THEN 'unpublished'
      WHEN p.status = 'active' AND p.expires_at IS NOT NULL AND p.expires_at <= now() THEN 'expired'
      ELSE p.status
    END AS status
  FROM site_publications p
  JOIN sites s ON s.id = p.site_id
  ORDER BY p.hostname, (p.status = 'active') DESC, p.ended_at DESC NULLS FIRST, p.published_at DESC
) latest
JOIN sites s ON s.id = latest.site_id
JOIN site_versions v ON v.id = latest.version_id
JOIN businesses b ON b.id = s.business_id
JOIN organizations o ON o.id = s.organization_id
LEFT JOIN org_settings os ON os.organization_id = s.organization_id;
