CREATE TABLE "site_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"business_id" uuid,
	"storage_key" text NOT NULL,
	"public_url" text,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"bytes" bigint,
	"sha256" text,
	"variants" jsonb,
	"license" text NOT NULL,
	"license_details" jsonb,
	"alt" jsonb,
	"dominant_colors" jsonb,
	"focal_point" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_site_assets__license" CHECK ("site_assets"."license" IN ('owner_site', 'stock', 'ai_generated', 'uploaded')),
	CONSTRAINT "ck_site_assets__status" CHECK ("site_assets"."status" IN ('pending', 'processing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "site_publications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"hostname" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "ck_site_publications__environment" CHECK ("site_publications"."environment" IN ('preview', 'live')),
	CONSTRAINT "ck_site_publications__status" CHECK ("site_publications"."status" IN ('active', 'expired', 'unpublished')),
	CONSTRAINT "ck_site_publications__ended" CHECK (("site_publications"."status" = 'active') = ("site_publications"."ended_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "site_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_hash" text NOT NULL,
	"schema_version" smallint NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text,
	"parent_version_id" uuid,
	"change_summary" text,
	"validation" jsonb NOT NULL,
	"quality" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_site_versions__version_number" CHECK ("site_versions"."version_number" >= 1),
	CONSTRAINT "ck_site_versions__author_type" CHECK ("site_versions"."author_type" IN ('user', 'generation_job', 'chat_edit', 'import', 'rollback')),
	CONSTRAINT "ck_site_versions__spec_hash" CHECK ("site_versions"."spec_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "site_view_daily" (
	"site_id" uuid NOT NULL,
	"day" date NOT NULL,
	"page_views" integer DEFAULT 0 NOT NULL,
	"unique_estimate" integer DEFAULT 0 NOT NULL,
	"by_locale" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"by_campaign" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "pk_site_view_daily" PRIMARY KEY("site_id","day"),
	CONSTRAINT "ck_site_view_daily__counts" CHECK ("site_view_daily"."page_views" >= 0 AND "site_view_daily"."unique_estimate" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"default_locale" text DEFAULT 'fr' NOT NULL,
	"current_version_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_sites__status" CHECK ("sites"."status" IN ('draft', 'preview', 'live', 'archived')),
	CONSTRAINT "ck_sites__slug" CHECK ("sites"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$')
);
--> statement-breakpoint
ALTER TABLE "site_assets" ADD CONSTRAINT "site_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_assets" ADD CONSTRAINT "site_assets_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_assets" ADD CONSTRAINT "site_assets_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_assets" ADD CONSTRAINT "site_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_publications" ADD CONSTRAINT "site_publications_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_publications" ADD CONSTRAINT "site_publications_version_id_site_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."site_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_publications" ADD CONSTRAINT "site_publications_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_versions" ADD CONSTRAINT "site_versions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_versions" ADD CONSTRAINT "fk_site_versions__parent_version" FOREIGN KEY ("parent_version_id") REFERENCES "public"."site_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_view_daily" ADD CONSTRAINT "site_view_daily_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_current_version_id_site_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."site_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_site_assets__organization_id_site_id" ON "site_assets" USING btree ("organization_id","site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_site_assets__storage_key" ON "site_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_site_publications__active_environment" ON "site_publications" USING btree ("site_id","environment") WHERE "site_publications"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_site_publications__active_hostname" ON "site_publications" USING btree ("hostname") WHERE "site_publications"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_site_publications__expires_at" ON "site_publications" USING btree ("expires_at") WHERE "site_publications"."status" = 'active' AND "site_publications"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_site_publications__version_id" ON "site_publications" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_site_versions__site_id_version_number" ON "site_versions" USING btree ("site_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sites__slug" ON "sites" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_sites__organization_id_created_at" ON "sites" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_sites__organization_id_business_id" ON "sites" USING btree ("organization_id","business_id");--> statement-breakpoint
CREATE INDEX "idx_sites__business_id" ON "sites" USING btree ("business_id");--> statement-breakpoint
CREATE TRIGGER sites_set_updated_at BEFORE UPDATE ON "sites" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- Site versions are immutable (BF-035): a rollback or an edit is a new version. The one exception is the quality
-- gates' report (BF-045), set once on a version that has none. Deletes stay possible (a site deleted cascades).
CREATE OR REPLACE FUNCTION site_versions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.quality IS NULL AND NEW.quality IS NOT NULL AND (to_jsonb(NEW) - 'quality') = (to_jsonb(OLD) - 'quality') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'site_versions rows are immutable (only quality may be set, once)' USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER site_versions_immutable BEFORE UPDATE ON "site_versions" FOR EACH ROW EXECUTE FUNCTION site_versions_immutable();--> statement-breakpoint
-- The site renderer's read model (BF-036, ADR-0004): one row per active publication of a site that is not archived,
-- with the version's spec and what the preview banner and robots need. The renderer connects as bf_sites_ro and can
-- read only this view and the public columns of site_assets (the view runs with its owner's rights).
CREATE VIEW renderer_published_sites WITH (security_barrier) AS
SELECT
  p.hostname,
  s.id AS site_id,
  s.organization_id,
  b.display_name AS business_name,
  coalesce(nullif(btrim(os.agency_name), ''), o.name) AS agency_name,
  os.website_url AS agency_url,
  p.environment,
  p.version_id,
  v.spec,
  p.expires_at,
  (p.environment = 'preview' OR coalesce((v.spec -> 'settings' ->> 'noindex')::boolean, true)) AS noindex
FROM site_publications p
JOIN sites s ON s.id = p.site_id
JOIN site_versions v ON v.id = p.version_id
JOIN businesses b ON b.id = s.business_id
JOIN organizations o ON o.id = s.organization_id
LEFT JOIN org_settings os ON os.organization_id = s.organization_id
WHERE p.status = 'active' AND s.status <> 'archived';--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'bf_sites_ro') THEN
    GRANT SELECT ON renderer_published_sites TO bf_sites_ro;
    GRANT SELECT (id, site_id, public_url, mime, width, height, variants, alt, focal_point, dominant_colors)
      ON site_assets TO bf_sites_ro;
  END IF;
END
$$;
