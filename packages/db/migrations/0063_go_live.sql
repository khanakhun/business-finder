CREATE TABLE "site_contact_routing" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"recipient_email" "citext",
	"cc" "citext",
	"verified_at" timestamp with time zone,
	"pending_email" "citext",
	"pending_cc" "citext",
	"token_hash" text,
	"token_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_legal_profiles" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_legal_name" text NOT NULL,
	"legal_form" text,
	"registration" text,
	"vat_number" text,
	"address" text NOT NULL,
	"phone" text,
	"email" "citext" NOT NULL,
	"publication_director" text,
	"dpo_contact" text,
	"privacy_acknowledged_at" timestamp with time zone,
	"content_confirmed_by" text,
	"content_confirmed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_contact_routing" ADD CONSTRAINT "site_contact_routing_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_contact_routing" ADD CONSTRAINT "site_contact_routing_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_legal_profiles" ADD CONSTRAINT "site_legal_profiles_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_legal_profiles" ADD CONSTRAINT "site_legal_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_legal_profiles" ADD CONSTRAINT "site_legal_profiles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_site_contact_routing__token" ON "site_contact_routing" USING btree ("token_hash");--> statement-breakpoint
-- BF-062: a live publication shows no preview banner and may be indexed; a preview never is.
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
  (latest.environment = 'preview') AS preview_banner
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
