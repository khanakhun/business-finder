CREATE TABLE "provider_usage" (
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"sku" text NOT NULL,
	"day" date NOT NULL,
	"billing_scope" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"results" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_usage_pkey" PRIMARY KEY("organization_id","provider","sku","day","billing_scope"),
	CONSTRAINT "ck_provider_usage__provider" CHECK ("provider_usage"."provider" IN ('google_places', 'overture', 'foursquare', 'osm', 'gmaps_scraper', 'fake')),
	CONSTRAINT "ck_provider_usage__counts" CHECK ("provider_usage"."calls" >= 0 AND "provider_usage"."results" >= 0 AND "provider_usage"."cost_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "discovery" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_provider_usage__billing_scope_provider_sku_day" ON "provider_usage" USING btree ("billing_scope","provider","sku","day");--> statement-breakpoint
-- Keep updated_at current for writes that bypass the app (repo convention, migration 0000).
CREATE TRIGGER provider_usage_set_updated_at BEFORE UPDATE ON "provider_usage" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
